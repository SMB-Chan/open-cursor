import json
import re

with open('/tmp/Rintetsu_ryoubi/manifest.json', 'r') as f:
    manifest = json.load(f)

manifest['start_url'] = './index.html'
manifest['scope'] = './'
manifest['icons'][0]['src'] = './icon.svg'

with open('/tmp/Rintetsu_ryoubi/manifest.json', 'w') as f:
    json.dump(manifest, f, indent=2)

with open('/tmp/Rintetsu_ryoubi/sw.js', 'r') as f:
    sw = f.read()

# Bump cache version
sw = re.sub(r'timetable-cache-v\d+', 'timetable-cache-v5', sw)

# Update urlsToCache
sw = sw.replace("'/Rintetsu_ryoubi/'", "'./'")
sw = sw.replace("'/Rintetsu_ryoubi/index.html'", "'./index.html'")
sw = sw.replace("'/Rintetsu_ryoubi/manifest.json'", "'./manifest.json'")
sw = sw.replace("'/Rintetsu_ryoubi/icon.svg'", "'./icon.svg'")

with open('/tmp/Rintetsu_ryoubi/sw.js', 'w') as f:
    f.write(sw)
