"""Local GPU lease client; keeps ownership through request completion/interruption."""
import contextlib,json,threading
from urllib.request import Request,urlopen
from urllib.error import HTTPError
BASE='http://127.0.0.1:18990'
def call(path,data=None,timeout=920):
    request=Request(BASE+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})
    try:
        with urlopen(request,timeout=timeout) as response:return json.load(response)
    except HTTPError as error:raise RuntimeError(json.load(error).get('error','Scheduler failed')) from error
@contextlib.contextmanager
def lease(model):
    ticket=call('/acquire',{'model':model});token=ticket['token'];stop=threading.Event()
    def renew():
        while not stop.wait(30):
            try:call('/renew',{'token':token},timeout=10)
            except Exception:break
    worker=threading.Thread(target=renew,daemon=True);worker.start()
    try:yield ticket
    finally:
        stop.set();worker.join(timeout=12)
        # Busy workers keep an expiring lease for safe reclamation, not forced stop.
        try:call('/release',{'token':token},timeout=15)
        except Exception:pass
