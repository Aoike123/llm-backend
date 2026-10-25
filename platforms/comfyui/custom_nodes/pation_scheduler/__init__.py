"""External worker coordination only; no Paiton model code is integrated here."""
from functools import wraps
from .client import lease
NODE_CLASS_MAPPINGS={}
def scheduled(model):
    def decorate(function):
        @wraps(function)
        def run(*args,**kwargs):
            try:
                with lease(model):return function(*args,**kwargs)
            except OSError as error:
                raise RuntimeError('轻量调度不可用，请先执行 ./lab scheduler start；查看 ./lab scheduler logs。') from error
        return run
    return decorate
