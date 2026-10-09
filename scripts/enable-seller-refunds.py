from pathlib import Path
import json,os
config=Path.home()/'.veylo-connector/config.json'
settings=json.loads(config.read_text())
identity=Path(input('Full path to this seller wallet’s .age identity file: ').strip()).expanduser().resolve()
if not identity.is_file():raise SystemExit('Identity file not found. No changes made.')
settings['identity']=str(identity)
tmp=config.with_suffix('.tmp')
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump(settings,f)
os.replace(tmp,config)
print('Saved the local identity path. No identity contents were uploaded. Restart the connector; each refund requires typing SEND.')
