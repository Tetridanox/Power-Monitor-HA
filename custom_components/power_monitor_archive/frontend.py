"""Install pinned frontend resources; never replace another integration's resources."""
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen


def dependencies():
    return json.loads(Path(__file__).with_name('frontend-dependencies.json').read_text(encoding='utf-8'))


def install_resource(directory, spec):
    directory = Path(directory)
    if Path(spec['file']).name != spec['file']:
        raise ValueError('invalid frontend filename')
    target = directory / spec['file']
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == spec['sha256']:
        return
    with urlopen(spec['url'], timeout=30) as response:
        body = response.read(spec['bytes'] + 1)
    if len(body) != spec['bytes'] or hashlib.sha256(body).hexdigest() != spec['sha256']:
        raise ValueError('frontend release checksum mismatch: ' + spec['name'])
    directory.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix('.js.pmnew')
    temporary.write_bytes(body)
    temporary.replace(target)


async def ensure_frontend_resources(hass, resources):
    await resources.async_get_info()
    specs = await hass.async_add_executor_job(dependencies)
    prefix = '/local/power_monitor_archive/vendor/'
    for spec in specs:
        url = prefix + spec['file'] + '?v=' + spec['version']
        matching = [x for x in resources.async_items() if x.get('url', '').split('?', 1)[0].rsplit('/', 1)[-1] == spec['file']]
        external = [x for x in matching if not x['url'].startswith(prefix)]
        owned = [x for x in matching if x['url'].startswith(prefix)]
        if external:
            # HACS/user assets win. Remove only our own duplicate registration.
            for item in owned:
                if hasattr(resources, 'async_delete_item'):
                    await resources.async_delete_item(item['id'])
                else:
                    resources.data.remove(item)
            continue
        await hass.async_add_executor_job(install_resource, hass.config.path('www', 'power_monitor_archive', 'vendor'), spec)
        if hasattr(resources, 'async_create_item'):
            if owned:
                for item in owned:
                    if item.get('url') != url or item.get('type') != 'module':
                        await resources.async_update_item(item['id'], {'url': url, 'res_type': 'module'})
            else:
                await resources.async_create_item({'url': url, 'res_type': 'module'})
        else:
            resources.data = [x for x in resources.async_items() if x not in owned] + [{'url': url, 'type': 'module'}]
    return True
