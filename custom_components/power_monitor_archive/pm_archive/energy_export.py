"""Bounded, append-only daily energy export planning; no HA or device I/O."""
from datetime import datetime, timezone
import math
import sqlite3
import struct

ENERGY_FIELDS=('pv','grid_import','load','battery_charge','battery_discharge')


def export_cutoff(stored, requested=None):
    """An imported archive prefix must never grow into its live successor."""
    for value in (stored, requested):
        if value is not None and (type(value) is not int or value < 1700000000):
            raise ValueError('Invalid archive cutoff')
    if stored is not None and requested is not None and stored != requested:
        raise ValueError('The established archive cutoff cannot be changed')
    return stored if stored is not None else requested


def daily_export(path,device,generation,before=None):
    before=export_cutoff(None,before)
    db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2)
    try:
        db.execute('PRAGMA query_only=ON');db.execute('PRAGMA cache_size=-512')
        rows=db.execute('''SELECT timestamp,raw FROM variants WHERE device=? AND generation=?
            AND kind='daily' AND provisional=0 AND timestamp<?
            GROUP BY record_id HAVING COUNT(*)=1
            ORDER BY timestamp LIMIT 3661''',(device,generation,before or 0x100000000)).fetchall()
        if len(rows)>3660:raise ValueError('Export is bounded to 3660 daily records')
        result=[]
        for stamp,raw in rows:
            if stamp<1700000000 or stamp>=int(datetime.now(timezone.utc).timestamp()):continue
            values=struct.unpack_from('<5f',raw,8)
            valid_minutes=struct.unpack_from('<I',raw,48)[0]
            if any(not math.isfinite(v) or v<0 for v in values):continue
            # DAY2 has no battery-valid-minute counter. A positive measured
            # battery total is usable; an unqualified zero is not evidence.
            energies=[v/1000 if (valid_minutes if i<3 else v>0) else None for i,v in enumerate(values)]
            if any(v is not None for v in energies):
                result.append({'timestamp':stamp,**dict(zip(ENERGY_FIELDS,energies))})
        return result
    finally:db.close()


def external_rows(days,field,last=None):
    """Never alter an imported prefix, including when older backfill arrives."""
    days=[day for day in days if day.get(field) is not None]
    if not days:return []
    after=last['start'] if last else -1
    total=float(last['sum']) if last else 0.0
    result=[]
    if not last:
        result.append({'start':datetime.fromtimestamp(days[0]['timestamp']//3600*3600-3600,timezone.utc),'state':0.0,'sum':0.0})
    for day in days:
        start=day['timestamp']//3600*3600
        if start<=after:continue
        total+=day[field]
        result.append({'start':datetime.fromtimestamp(start,timezone.utc),'state':total,'sum':total})
    return result


