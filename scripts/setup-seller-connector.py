from pathlib import Path
import os,json,getpass,re
from urllib.parse import urlparse
root=Path(__file__).resolve().parent.parent
site=input('Veylo website URL [https://veylo-steel.vercel.app]: ').strip() or 'https://veylo-steel.vercel.app'
u=urlparse(site)
if u.scheme!='https' or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ('','/'):
    raise SystemExit('Use the exact HTTPS website origin.')
token=getpass.getpass('Store pairing credential (hidden): ').strip()
if not re.fullmatch('[0-9a-f]{64}',token): raise SystemExit('Invalid pairing credential.')
binary=Path(input('Full path to working zcash-devtool binary: ').strip()).expanduser().resolve()
wallet=Path(input('Full path to seller wallet directory: ').strip()).expanduser().resolve()
account=input('Seller wallet account UUID: ').strip()
if not binary.is_file() or not os.access(binary,os.X_OK) or not wallet.is_dir() or not re.fullmatch('[a-f0-9-]{36}',account):raise SystemExit('Check the binary, wallet directory and account UUID.')
folder=Path.home()/'.veylo-connector';folder.mkdir(mode=0o700,exist_ok=True)
target=folder/'config.json'
if target.exists():raise SystemExit('Connector configuration already exists. Rename it privately before setting up a replacement.')
fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:json.dump(dict(site=site.rstrip('/'),token=token,binary=str(binary),wallet=str(wallet),account=account),f)
print('Saved local connector settings. Next: node scripts/seller-connector.mjs')
