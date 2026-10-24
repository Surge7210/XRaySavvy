#!/bin/bash
set -e
D=/workspace/xraysavvy/diagrams
for n in hand-pa ankle-mortise cspine-lateral; do
  cat > /tmp/r-$n.html <<H
<html><body style="margin:0;background:#0f1419"><img src="file://$D/$n.svg" style="display:block;width:800px;height:600px"></body></html>
H
  google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=800,600 --screenshot=$D/preview-$n.png file:///tmp/r-$n.html >/dev/null 2>&1
done
python3 - <<P
from PIL import Image
ims=[Image.open(f"$D/preview-{n}.png").convert("RGB") for n in ["hand-pa","ankle-mortise","cspine-lateral"]]
g=16; W=800; H=sum(i.height for i in ims)+g*4
out=Image.new("RGB",(W+2*g,H),(15,20,25)); y=g
for i in ims: out.paste(i,(g,y)); y+=i.height+g
out.save("$D/preview-all.png"); print(out.size)
P
