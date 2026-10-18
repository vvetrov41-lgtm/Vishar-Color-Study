import numpy as np, glob, sys
from PIL import Image
S=sys.argv[1]
def load(n,k):
    f=glob.glob(f'{S}/dl_out/{n}_{k}_*')[0]; return np.asarray(Image.open(f).convert('RGB')).astype(np.float64)
def lab(rgb):
    c=rgb/255; l=np.where(c<=0.04045,c/12.92,((c+0.055)/1.055)**2.4)
    M=np.array([[0.4124,0.3576,0.1805],[0.2126,0.7152,0.0722],[0.0193,0.1192,0.9505]])
    xyz=l@M.T/np.array([0.95047,1,1.08883]); f=np.where(xyz>0.008856,np.cbrt(xyz),7.787*xyz+16/116)
    return np.stack([116*f[...,1]-16,500*(f[...,0]-f[...,1]),200*(f[...,1]-f[...,2])],-1)
for n in ['stilllife_1k','landscape_1k','portrait_1k','flash_1k']:
    src=load(n,'cmap').reshape(-1,3); out=load(n,'temp').reshape(-1,3)
    uo,inv,cnt=np.unique(out,axis=0,return_inverse=True,return_counts=True)
    print('====',n,'unique out colors',len(uo))
    top=np.argsort(-cnt)[:8]
    for t in top: print('   out',uo[t].astype(int),f'{cnt[t]/len(out)*100:.1f}%', ' src mean',src[inv.ravel()==t].mean(0).astype(int))
    Ls=lab(src); Lo=lab(out)
    # warm/cool sign of output: b* of output (orange>0, blue<0)
    so=Lo[:,2]
    cands={'R-B':src[:,0]-src[:,2],'b*':Ls[:,2],'a*+b*':Ls[:,1]+Ls[:,2],'hue cos(h-50)':np.hypot(Ls[:,1],Ls[:,2])*np.cos(np.arctan2(Ls[:,2],Ls[:,1])-np.radians(50))}
    for k,v in cands.items():
        print(f'   corr(out b*, {k}) = {np.corrcoef(so,v)[0,1]:.3f}   sign agree {(np.sign(so)==np.sign(v-np.median(v))).mean()*100:.1f}%')
    print('   out L* vs src L* corr', np.corrcoef(Lo[:,0],Ls[:,0])[0,1].round(3))
