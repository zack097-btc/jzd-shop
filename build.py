# Stages the Shop Manager into the desktop shell and refuses to do it if the
# version numbers disagree.
#
#   python build.py        (run from the repository root)
#
# The version is on screen in Settings, so it has to be TRUE. Three files carry
# it and if they drift the installer says one thing while the app says another,
# which is worse than no version at all.

import json, os, re, shutil

src = open('index.html', encoding='utf-8').read()

_v = re.search(r'const JZD_VERSION = "([^"]+)"', src)
assert _v, 'no JZD_VERSION in index.html'
UIV = _v.group(1)

_conf = json.load(open('desktop/src-tauri/tauri.conf.json', encoding='utf-8'))
CONFV = _conf.get('version')
CARGOV = re.search(r'^version\s*=\s*"([^"]+)"',
                   open('desktop/src-tauri/Cargo.toml', encoding='utf-8').read(),
                   re.M).group(1)

assert UIV == CONFV == CARGOV, (
    'version drift: index.html=%s tauri.conf.json=%s Cargo.toml=%s' % (UIV, CONFV, CARGOV))
print('version', UIV, '(page / tauri.conf / Cargo.toml agree)')

# The desktop build has no service worker and no manifest: it is a program, not
# a web page, and its data is a file rather than browser storage.
os.makedirs('desktop/dist', exist_ok=True)
for f in os.listdir('desktop/dist'):
    os.remove(os.path.join('desktop/dist', f))
shutil.copy('index.html', 'desktop/dist/index.html')
for icon in ('icon-192.png', 'icon-512.png'):
    if os.path.exists(icon):
        shutil.copy(icon, os.path.join('desktop/dist', icon))
print('staged desktop/dist:', sorted(os.listdir('desktop/dist')))
