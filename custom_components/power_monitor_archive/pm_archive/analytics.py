"""Optional HA-side battery observations and fixed tariff estimates.

The archive.sqlite schema and the ESP codecs stay untouched. The existing
writer owns this sidecar; readers never open an independent ESP connection.
"""
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import sqlite3
from zoneinfo import ZoneInfo

from .store import ArchiveError


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def cost_settings(value=None):
    if value is None: value = {}
    allowed = {'mode', 'dayPrice', 'nightPrice', 'nightStart', 'nightEnd', 'currency', 'timeZone', 'timeZoneMode'}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ArchiveError('invalid cost settings')
    result = {'mode': 'flat', 'dayPrice': 0.0, 'nightPrice': 0.0, 'nightStart': 1380,
              'nightEnd': 420, 'currency': 'UAH', 'timeZone': 'Europe/Kyiv', 'timeZoneMode':'manual', **value}
    if result['timeZoneMode'] not in ('home_assistant','manual'):
        raise ArchiveError('invalid timezone mode')
    if result['mode'] not in ('flat', 'day_night') or not isinstance(result['currency'],str) or not re.fullmatch('[A-Z]{3}', result['currency']):
        raise ArchiveError('invalid tariff or currency')
    for key in ('dayPrice', 'nightPrice'):
        if not finite(result[key]) or not 0 <= result[key] <= 10000:
            raise ArchiveError('invalid price')
    for key in ('nightStart', 'nightEnd'):
        if type(result[key]) is not int or not 0 <= result[key] <= 1439:
            raise ArchiveError('invalid tariff time')
    try:
        ZoneInfo(result['timeZone'])
    except (KeyError, TypeError, ValueError) as error:
        raise ArchiveError('invalid timezone') from error
    return result


def resolved_cost_settings(value,ha_timezone):
    """Follow HA unless the user explicitly chose a different timezone."""
    if value is None:return None
    if not isinstance(value,dict):raise ArchiveError('invalid cost settings')
    result=dict(value)
    mode=result.get('timeZoneMode','home_assistant' if not result.get('timeZone') or result['timeZone']==ha_timezone else 'manual')
    result['timeZoneMode']=mode
    if mode=='home_assistant':result['timeZone']=ha_timezone
    return cost_settings(result)


def price_at(timestamp, settings):
    if settings['mode'] == 'flat':
        return settings['dayPrice']
    local = datetime.fromtimestamp(timestamp, ZoneInfo(settings['timeZone']))
    minute = local.hour * 60 + local.minute
    start, end = settings['nightStart'], settings['nightEnd']
    night = start <= minute < end if start < end else minute >= start or minute < end
    return settings['nightPrice'] if night else settings['dayPrice']


def minute_cost(rows, settings, start, end):
    """Integrate only observed <=120s intervals, splitting tariff/DST boundaries."""
    totals = {'gridKwh': 0.0, 'pvKwh': 0.0, 'cost': 0.0, 'pvValueEstimate': 0.0,
              'coveredSeconds': 0, 'gapCount': 0}
    previous = None
    for timestamp, raw in rows:
        import struct
        fields = struct.unpack('<III8H4bBBHH', raw)
        if previous:
            before, old = previous
            delta = timestamp - before
            if 0 < delta <= 120 and old[16] & 1 and fields[16] & 1:
                at, stop = max(start, before), min(end, timestamp)
                while at < stop:
                    edge = min(stop, (at // 60 + 1) * 60)
                    seconds = edge - at
                    grid, pv = old[4] * seconds / 3600000, old[3] * seconds / 3600000
                    rate = price_at(at, settings)
                    totals['gridKwh'] += grid; totals['pvKwh'] += pv
                    totals['cost'] += grid * rate; totals['pvValueEstimate'] += pv * rate
                    totals['coveredSeconds'] += seconds
                    at = edge
            elif delta > 120:
                totals['gapCount'] += 1
        previous = timestamp, fields
    return totals


def battery_record(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get('available') is not True:
        return None
    mac=snapshot.get('macAddress')
    if not isinstance(mac,str):return None
    identity = mac.lower().replace(':', '')
    if not re.fullmatch('[0-9a-f]{12}', identity) or not isinstance(snapshot.get('data'), dict):
        return None
    source, result = snapshot['data'], {}
    for key in ('stateOfHealth', 'stateOfCharge', 'cycleCount', 'deltaCellVoltage',
                'temperature1', 'temperature2', 'mosfetTemperature', 'current', 'balanceCurrent'):
        value = source.get(key)
        result[key] = value if finite(value) else None
    for key in ('stateOfHealth', 'stateOfCharge'):
        if result[key] is not None and not 0 <= result[key] <= 100:
            result[key] = None
    if result['cycleCount'] is not None and not 0 <= result['cycleCount'] <= 0xffffffff:
        result['cycleCount'] = None
    if result['deltaCellVoltage'] is not None and not 0 <= result['deltaCellVoltage'] <= 10:
        result['deltaCellVoltage'] = None
    cells = source.get('cellVoltages', [])
    if not isinstance(cells, list) or len(cells) > 32:
        raise ArchiveError('invalid battery cells')
    count=source.get('cellCount',len(cells))
    if type(count) is not int or not 0<=count<=32:
        raise ArchiveError('invalid battery cell count')
    result['cellCount']=count
    result['cells'] = [v if finite(v) and 0 < v < 10 else None for v in cells[:count]]
    result['cells'] += [None]*(count-len(result['cells']))
    result['balancing'] = source.get('balancing') if type(source.get('balancing')) is bool else None
    return identity, result


class AnalyticsStore:
    """One existing writer; five-minute observations, identity is physical MAC."""
    def __init__(self, path):
        self.connection = sqlite3.connect(path, isolation_level=None, timeout=2)
        try:
            version=self.connection.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0,1):
                raise ArchiveError('unsupported analytics schema')
            if version==0 and self.connection.execute("SELECT 1 FROM sqlite_master WHERE type='table'").fetchone():
                raise ArchiveError('refusing to adopt an unrelated analytics database')
            self.connection.execute('PRAGMA journal_mode=WAL')
            self.connection.execute('PRAGMA synchronous=FULL')
            self.connection.execute('PRAGMA cache_size=-512')
            self.connection.execute('PRAGMA wal_autocheckpoint=64')
            self.connection.execute('PRAGMA journal_size_limit=4194304')
            if version==0:
                self.connection.executescript('''BEGIN IMMEDIATE;
                CREATE TABLE battery (
                device TEXT NOT NULL, generation TEXT NOT NULL, slot INTEGER NOT NULL,
                identity TEXT NOT NULL, bucket INTEGER NOT NULL, observed INTEGER NOT NULL,
                data TEXT NOT NULL, PRIMARY KEY(device,generation,slot,identity,bucket));
                CREATE INDEX battery_time ON battery(device,generation,slot,observed);
                PRAGMA user_version=1; COMMIT;''')
        except BaseException:
            self.connection.close(); raise

    def close(self):
        self.connection.close()

    def observe(self, device, generation, slot, timestamp, snapshot):
        if not finite(timestamp) or timestamp < 1700000000 or type(slot) is not int or slot not in (0, 1):
            raise ArchiveError('invalid observation')
        record = battery_record(snapshot)
        if not record:
            return False
        identity, data = record
        self.connection.execute('INSERT OR IGNORE INTO battery VALUES(?,?,?,?,?,?,?)',
            (device, generation, slot, identity, int(timestamp) // 300, int(timestamp),
             json.dumps(data, separators=(',', ':'), allow_nan=False)))
        return True


def read_battery(path, device, generation, slot, start, end, maximum):
    if type(slot) is not int or slot not in (0, 1) or not 0 < end-start <= 366*86400 or not 10 <= maximum <= 2000:
        raise ArchiveError('invalid battery history range')
    empty = {'points': [], 'heatmap': [], 'balancing': [], 'identity': None, 'cellCount':0,
             'source': 'HA five-minute observations', 'sampleIntervalSeconds': 300}
    if not Path(path).exists():
        return empty
    db = sqlite3.connect(Path(path).as_uri()+'?mode=ro', uri=True, timeout=2)
    try:
        db.execute('PRAGMA query_only=ON'); db.execute('PRAGMA cache_size=-512')
        identity = db.execute('SELECT identity FROM battery WHERE device=? AND generation=? AND slot=? AND observed<=? ORDER BY observed DESC LIMIT 1',
            (device, generation, slot, end)).fetchone()
        if not identity:
            return empty
        rows = db.execute('SELECT observed,data FROM battery WHERE device=? AND generation=? AND slot=? AND identity=? AND observed>=? AND observed<=? ORDER BY observed',
            (device, generation, slot, identity[0], start, end))
        bins, days, transitions = {}, {}, []
        width = max(300, math.ceil((end-start+1)/maximum))
        prior = None
        cell_count=0
        for timestamp, raw in rows:
            value = json.loads(raw)
            cell_count=value.get('cellCount',len(value['cells']))
            bucket = (timestamp-start)//width
            point = bins.setdefault(bucket, {'timestamp': timestamp, 'samples': 0, 'deltaMax': None})
            point.update({k: value[k] for k in ('stateOfHealth','stateOfCharge','cycleCount','current','temperature1')})
            point['timestamp']=timestamp
            point['samples'] += 1
            delta = value['deltaCellVoltage']
            if delta is not None:
                point['deltaMax'] = max(delta, point['deltaMax'] or 0)
            date = datetime.fromtimestamp(timestamp, ZoneInfo('Europe/Kyiv')).date().isoformat()
            day = days.setdefault(date, {'date': date, 'sums': [0.0]*32, 'counts': [0]*32, 'samples': 0, 'balancingSamples': 0})
            day['samples'] += 1; day['balancingSamples'] += value['balancing'] is True
            valid = [v for v in value['cells'] if v is not None]
            mean = sum(valid)/len(valid) if valid else None
            if mean is not None:
                for cell, voltage in enumerate(value['cells']):
                    if voltage is not None:
                        day['sums'][cell] += (voltage-mean)*1000; day['counts'][cell] += 1
            state = value['balancing']
            if state is not None and (prior is None or prior[1] != state or timestamp-prior[0] > 600):
                transitions.append({'timestamp':timestamp,'active':state,'afterGap':prior is None or timestamp-prior[0]>600})
            prior = timestamp, state
        heatmap = [{'date':d['date'],'samples':d['samples'],'balancingSamples':d['balancingSamples'],
                    'deviationMv':[total/count if count else None for total,count in zip(d['sums'],d['counts'])]} for d in days.values()]
        return {**empty,'identity':identity[0],'cellCount':cell_count,'points':list(bins.values())[:maximum],
                'heatmap':heatmap,'balancing':transitions[-64:], 'downsampleSeconds':width,
                'notice':'Observed values depend on SOC, current and temperature; no failure or EOL prediction. Balancing entries are sampled observations, not exact switching times.'}
    finally:
        db.close()
