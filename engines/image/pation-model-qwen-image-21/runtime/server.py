"""Local JSON image API. One GPU request at a time; no URL/file fetching."""
import base64
import binascii
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import io
import json
import time
from PIL import Image,UnidentifiedImageError

def serve(engine,host,port):
    model_id=getattr(engine,"model_id","paiton-image-2.1")
    class Handler(BaseHTTPRequestHandler):
        def send_json(self,status,value):
            payload=json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            if self.path=="/health":
                self.send_json(200,dict(status="ready",busy=engine.busy.locked(),backend=engine.backend,native_fusions=engine.native_fusion_status,
                    allocator_budget_gib=engine.allocator_budget_gib,allocator_config=engine.allocator_config,
                    checkpoint_sha256=engine.checkpoint_sha256,load_seconds=engine.load_seconds,
                    model=model_id,model_variant=getattr(engine,"model_variant","original")))
            elif self.path=="/v1/models":
                self.send_json(200,dict(object="list",data=[dict(id=model_id,object="model",
                    owned_by="EliovpAI",tasks=["text-to-image","rgba","edit"],batch_size=1,
                    generation_sizes=["1024x1024","2048x2048"],rgba_sizes=["1024x1024","2048x2048"],
                    edit_sizes=["1024x1024"],max_reference_images=4,steps=40,guidance=1.0)]))
            else:
                self.send_json(404,dict(error="Unknown endpoint"))

        def do_POST(self):
            if self.path not in ("/v1/images/generations","/v1/images/edits"):
                self.send_json(404,dict(error="Unknown endpoint"));return
            try:
                length=int(self.headers.get("Content-Length","0"))
                if not 0<length<=32*2**20:
                    raise ValueError("JSON request must be at most 32 MiB")
                body=json.loads(self.rfile.read(length))
                if not isinstance(body,dict):
                    raise ValueError("JSON body must be an object")
                allowed={"prompt","size","seed","mode","image_b64","images_b64","n","model","steps","guidance","response_format"}
                if set(body)-allowed:
                    raise ValueError("Unsupported fields: "+", ".join(sorted(set(body)-allowed)))
                if type(body.get("n",1)) is not int or body.get("n",1)!=1 or body.get("model",model_id)!=model_id:
                    raise ValueError(f"Use model {model_id} and n=1")
                if body.get("response_format","b64_json")!="b64_json":
                    raise ValueError("response_format must be b64_json")
                size=body.get("size","2048x2048")
                if size not in ("1024x1024","2048x2048"):
                    raise ValueError("Unsupported size")
                width,height=map(int,size.split("x"))
                source=None
                mode=body.get("mode","text-to-image")
                if self.path.endswith("/edits"):
                    mode="edit"
                    if "image_b64" in body and "images_b64" in body:
                        raise ValueError("Use image_b64 or images_b64, not both")
                    references=body.get("images_b64",[body.get("image_b64","")])
                    if not isinstance(references,list) or not 1<=len(references)<=4:
                        raise ValueError("images_b64 must contain 1–4 PNG images")
                    source=[]
                    for encoded in references:
                        data=base64.b64decode(encoded,validate=True)
                        item=Image.open(io.BytesIO(data))
                        if item.width*item.height>2048*2048:raise ValueError("Reference image exceeds pixel limit")
                        item.load();source.append(item)
                    if sum(item.width*item.height for item in source)>2048*2048:
                        raise ValueError("Combined references exceed 4,194,304 pixels")
                elif "image_b64" in body or "images_b64" in body:
                    raise ValueError("Use the edits endpoint for input images")
                image,png,report=engine.generate(body.get("prompt"),width=width,height=height,
                    steps=body.get("steps",40),guidance=body.get("guidance",1.0),seed=body.get("seed",42),mode=mode,image=source)
                self.send_json(200,dict(created=int(time.time()),data=[dict(b64_json=base64.b64encode(png).decode())],metrics=report))
            except (ValueError,TypeError,UnidentifiedImageError,Image.DecompressionBombError,binascii.Error) as error:
                self.send_json(400,dict(error=str(error)))
            except RuntimeError as error:
                self.send_json(409 if "busy" in str(error) else 500,dict(error=str(error)))
    server=ThreadingHTTPServer((host,port),Handler)
    server.daemon_threads=True
    print(f"READY http://{host}:{port}; checkpoint {engine.checkpoint_sha256}",flush=True)
    server.serve_forever()
