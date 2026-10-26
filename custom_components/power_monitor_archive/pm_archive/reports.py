"""Read-only status and dependency-free PNG reports, rendered on HA."""
from datetime import datetime
from zoneinfo import ZoneInfo
import math
import struct
import zlib


def command_settings(value=None):
    defaults={'enabled':False,'telegramEntry':'','chatId':0,'userId':0,'language':'ru',
              'statusEnabled':True,'pvEnabled':True,'hours':24}
    if value is None:return defaults
    if not isinstance(value,dict) or set(value)-set(defaults):raise ValueError('Invalid Telegram settings')
    result={**defaults,**value}
    if any(type(result[key]) is not bool for key in ('enabled','statusEnabled','pvEnabled')):
        raise ValueError('Invalid Telegram switches')
    if result['language'] not in ('ru','uk','en') or type(result['hours']) is not int or not 1<=result['hours']<=168:
        raise ValueError('Invalid Telegram report options')
    if not isinstance(result['telegramEntry'],str) or len(result['telegramEntry'])>128:
        raise ValueError('Invalid Telegram bot')
    if any(type(result[key]) is not int or abs(result[key])>=2**52 for key in ('chatId','userId')):
        raise ValueError('Invalid Telegram identity')
    if result['enabled'] and (not result['telegramEntry'] or not result['chatId'] or result['userId']<=0):
        raise ValueError('Select a Telegram bot, chat and sender')
    if result['chatId']>0 and result['userId'] not in (0,result['chatId']):
        raise ValueError('A private chat must use its own sender')
    return result


def command_report(attributes,settings,username=''):
    """Telegram's three identities and command switches all have to match."""
    if not settings['enabled'] or not isinstance(attributes,dict) or attributes.get('event_type')!='telegram_command':return None
    bot=attributes.get('bot')
    if not isinstance(bot,dict) or bot.get('config_entry_id')!=settings['telegramEntry']:return None
    if any(type(attributes.get(key)) is not int or attributes[key]!=settings[target]
           for key,target in (('chat_id','chatId'),('user_id','userId'))):return None
    command=attributes.get('command')
    if not isinstance(command,str):return None
    parts=command.split('@',1)
    if len(parts)==2 and (not username or parts[1].casefold()!=username.casefold()):return None
    if parts[0]=='/status' and settings['statusEnabled']:return 'telegram_status'
    if parts[0]=='/pv' and settings['pvEnabled']:return 'telegram_generation_graph'
    return None


def status_text(current,language='ru'):
    labels={
        'ru':('данные недоступны','Инвертор','Сеть','Нагрузка','Батарея','онлайн','нет связи'),
        'uk':('дані недоступні','Інвертор','Мережа','Навантаження','Батарея','онлайн','немає зв’язку'),
        'en':('data unavailable','Inverter','Grid','Load','Battery','online','offline'),
    }[language]
    if not current.get('available'):
        return 'Power Monitor: '+labels[0]
    values=current.get('values',{})
    def value(key,unit):
        number=values.get(key)
        return f'{number:.1f} {unit}' if isinstance(number,(int,float)) and not isinstance(number,bool) and math.isfinite(number) else '—'
    def state(key):
        return labels[5] if values.get(key) is True else labels[6] if values.get(key) is False else '—'
    return '\n'.join(('Power Monitor',labels[1]+': '+state('inverter_available'),
        'BMS 1: '+state('bms1_available')+' · BMS 2: '+state('bms2_available'),
        'SOC: '+value('battery_soc','%'),'PV: '+value('pv_power','W'),
        labels[2]+': '+value('grid_power','W'),labels[3]+': '+value('load_power','W'),
        labels[4]+': '+value('battery_power','W')))


FONT={
 '0':['111','101','101','101','111'],'1':['010','110','010','010','111'],
 '2':['111','001','111','100','111'],'3':['111','001','111','001','111'],
 '4':['101','101','111','001','001'],'5':['111','100','111','001','111'],
 '6':['111','100','111','101','111'],'7':['111','001','010','010','010'],
 '8':['111','101','111','101','111'],'9':['111','101','111','001','111'],
 ':':['000','010','000','010','000'],'.':['000','000','000','000','010'],
 '-':['000','000','111','000','000'],'P':['110','101','110','100','100'],
 'V':['101','101','101','101','010'],'W':['101','101','111','111','101'],
 'U':['101','101','101','101','111'],'T':['111','010','010','010','010'],
 'C':['111','100','100','100','111'],' ':['000']*5,
}


def generation_png(points,start,end,time_zone='UTC'):
    """Fixed 960x420 image. Never interpolate across a missing minute range."""
    if not 0 < end-start <= 7*86400 or len(points)>2000:
        raise ValueError('invalid report range')
    zone=ZoneInfo(time_zone)
    width,height=960,420
    pixels=bytearray(bytes((24,29,36))*width*height)
    def dot(x,y,color):
        x,y=int(x),int(y)
        if 0<=x<width and 0<=y<height:
            at=(y*width+x)*3; pixels[at:at+3]=bytes(color)
    def line(x0,y0,x1,y1,color):
        steps=max(1,int(max(abs(x1-x0),abs(y1-y0))))
        for i in range(steps+1):dot(x0+(x1-x0)*i/steps,y0+(y1-y0)*i/steps,color)
    def label(x,y,value,color=(200,211,220),scale=4):
        for char in str(value):
            for row,bits in enumerate(FONT.get(char,FONT[' '])):
                for col,bit in enumerate(bits):
                    if bit=='1':
                        for dx in range(scale):
                            for dy in range(scale):dot(x+col*scale+dx,y+row*scale+dy,color)
            x+=4*scale
    def measured(point):
        power,stamp=point.get('pvPower'),point.get('timestamp')
        return (isinstance(power,(int,float)) and not isinstance(power,bool) and math.isfinite(power) and power>=0
            and isinstance(stamp,(int,float)) and not isinstance(stamp,bool) and math.isfinite(stamp) and start<=stamp<=end)
    valid=[p for p in points if measured(p)]
    maximum=max(100,max((p['pvPower'] for p in valid),default=0))
    magnitude=10**math.floor(math.log10(maximum/4))
    step=next(n*magnitude for n in (1,2,2.5,5,10) if n*magnitude>=maximum/4)
    maximum=math.ceil(maximum/step)*step
    for i in range(5):
        y=350-i*75;line(110,y,930,y,(55,65,76));label(4,y-9,f'{maximum*i/4:.0f}')
    label(110,15,'PV W')
    for i in range(5):
        timestamp=start+(end-start)*i/4
        value=datetime.fromtimestamp(timestamp,zone).strftime('%H:%M' if end-start<=2*86400 else '%m-%d')
        label(110+i*205-(0 if i==0 else len(value)*16 if i==4 else len(value)*8),370,value)
    label(110,399,datetime.fromtimestamp(start,zone).strftime('%Y-%m-%d'),scale=3)
    previous=None
    for point in points:
        if not measured(point) or point.get('gapBefore'):
            previous=None
        if not measured(point):continue
        power,timestamp=point['pvPower'],point['timestamp']
        current=(110+(timestamp-start)/(end-start)*820,350-max(0,power)/maximum*300,timestamp)
        if previous and timestamp-previous[2]<=max(120,(end-start)/1000*2):
            line(previous[0],previous[1],current[0],current[1],(255,196,76))
        else:dot(current[0],current[1],(255,196,76))
        previous=current
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    scan=b''.join(b'\0'+pixels[y*width*3:(y+1)*width*3] for y in range(height))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(scan,6))+chunk(b'IEND',b'')
