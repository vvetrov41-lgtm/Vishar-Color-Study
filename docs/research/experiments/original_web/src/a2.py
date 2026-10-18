import numpy as np, glob, sys
from PIL import Image
S=sys.argv[1]
def load(n,k):
    f=glob.glob(f'{S}/dl_out/{n}_{k}_*')[0]; return np.asarray(Image.open(f).convert('RGB')).astype(np.float64)
def km1d(hist, k, w, iters=100):
    x=np.arange(256.); ww=w(hist)
    nz=x[hist>0]; c=np.quantile(np.repeat(x,hist.astype(int)), (np.arange(k)+0.5)/k)
    c=np.linspace(nz.min(),nz.max(),k)
    for _ in range(iters):
        lab=np.argmin(np.abs(x[:,None]-c[None]),1)
        nc=np.array([ (ww[lab==j]*x[lab==j]).sum()/max(ww[lab==j].sum(),1e-9) if (ww[lab==j].sum()>0) else c[j] for j in range(k)])
        if np.allclose(nc,c): break
        c=nc
    c=np.sort(c); return (c[:-1]+c[1:])/2
def assign(v,th): return np.searchsorted(th, v)
for n in ['stilllife_1k','landscape_1k','flash_1k','portrait_1k']:
    src=load(n,'cmap'); Y=0.299*src[...,0]+0.587*src[...,1]+0.114*src[...,2]
    g=load(n,'val')[...,0]; lev=np.unique(g); orig=np.searchsorted(lev,g)
    Yi=np.clip(np.round(Y),0,255).astype(int); hist=np.bincount(Yi.ravel(),minlength=256).astype(float)
    # original thresholds in luma: midpoint between max of lower and min of upper
    th_o=[ (Y[orig==j].max()+Y[orig==j+1].min())/2 for j in range(8)]
    out=[f'orig {np.round(th_o,0).astype(int).tolist()}']
    cands={'even0-255':np.linspace(0,255,10)[1:-1],
           'even min-max':np.linspace(Y.min(),Y.max(),10)[1:-1],
           'kmeans count':km1d(hist,9,lambda h:h),
           'kmeans sqrt':km1d(hist,9,np.sqrt),
           'kmeans log':km1d(hist,9,np.log1p),
           'kmeans bin-present':km1d(hist,9,lambda h:(h>0).astype(float)),
           'quantile':np.quantile(Y,np.arange(1,9)/9)}
    print('====',n); print(' ',out[0])
    for k,th in cands.items():
        a=assign(Y,np.array(th)); agree=(a==orig).mean()
        print(f'  {k:18s} agree {agree*100:5.1f}%  th {np.round(th,0).astype(int).tolist()}')
    # representative gray vs mean luma per level
    print('  out gray', lev.astype(int).tolist()); print('  mean luma', [int(round(Y[orig==j].mean())) for j in range(len(lev))])
