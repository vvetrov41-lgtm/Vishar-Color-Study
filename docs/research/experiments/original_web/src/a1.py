import numpy as np, glob, sys
from PIL import Image
S=sys.argv[1]
def load(n,k):
    f=glob.glob(f'{S}/dl_out/{n}_{k}_*')[0]; return np.asarray(Image.open(f).convert('RGB')).astype(np.float64)
def srgb2lin(c):
    c=c/255; return np.where(c<=0.04045,c/12.92,((c+0.055)/1.055)**2.4)
def Lstar(rgb):
    l=srgb2lin(rgb); Y=0.2126*l[...,0]+0.7152*l[...,1]+0.0722*l[...,2]
    return np.where(Y>0.008856,116*np.cbrt(Y)-16,903.3*Y)
for n in ['stilllife_1k','landscape_1k','flash_1k','portrait_1k']:
    src=load(n,'cmap'); 
    orig=np.asarray(Image.open(f'{S}/img/{n}.jpg').convert('RGB')).astype(float)
    print('=====',n, 'cmap vs jpg mean abs diff', np.abs(src-orig).mean().round(2))
    L=Lstar(src); luma=0.299*src[...,0]+0.587*src[...,1]+0.114*src[...,2]
    # Values
    v=load(n,'val'); g=v[...,0]
    levels,counts=np.unique(g,return_counts=True)
    gray=np.allclose(v[...,0],v[...,1]) and np.allclose(v[...,1],v[...,2])
    print('values: gray',gray,'levels',len(levels), list(levels.astype(int)))
    print('  pct',list((counts/counts.sum()*100).round(1)))
    # thresholds in L* and luma: for each level boundary find max L of lower and min of upper
    bL=[];bY=[]
    for a,b in zip(levels[:-1],levels[1:]):
        lo=L[g==a]; hi=L[g==b]; bL.append((np.percentile(lo,99.5).round(1),np.percentile(hi,0.5).round(1)))
        lo=luma[g==a]; hi=luma[g==b]; bY.append((np.percentile(lo,99.5).round(1),np.percentile(hi,0.5).round(1)))
    print('  L* bounds',bL); print('  luma bounds',bY)
    # Notan
    nt=load(n,'notan')[...,0]; u=np.unique(nt); print('notan uniq',u[:6], 'black%',(nt<128).mean().round(3))
    for nm,arr in [('L*',L),('luma',luma)]:
        lo=arr[nt<128]; hi=arr[nt>=128]
        print(f'  notan {nm}: dark max(p99.5) {np.percentile(lo,99.5):.1f} light min(p0.5) {np.percentile(hi,0.5):.1f} median {np.median(arr):.1f} mean {arr.mean():.1f}')
    # Simplify
    sp=load(n,'simp'); cols=np.unique(sp.reshape(-1,3),axis=0); print('simplify unique colors',len(cols))
