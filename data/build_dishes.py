#!/usr/bin/env python3
"""Builds dishes.json from dishes.txt (our own table; no IFCT data used)."""
import json,os,re,sys
SRC={'U':('usda_fdc',"Generic values in line with USDA FoodData Central (public domain), scaled to portion; recalled, not re-fetched - verify per FDC ID before launch",0.10),
     'O':('open_food_facts',"Typical label values as seen on Open Food Facts (ODbL) for common Indian brands; varies by brand",0.10),
     'E':('estimate',"Our estimate: home-style recipe (ingredient grams + oil), not lab-measured",0.25)}
out=[];seen={}
for i,l in enumerate(open(os.path.join(os.path.dirname(__file__),'dishes.txt'))):
    l=l.strip()
    if not l: continue
    name,al,unit,g,k,p,oil,s=l.split('|')
    k,p,g=float(k),float(p),float(g); kind,note,sp=SRC[s]
    aliases=[a.strip() for a in al.split(',') if a.strip()]
    for t in [name]+aliases:
        if t in seen: sys.exit(f"duplicate term {t!r} in {name} and {seen[t]}")
        seen[t]=name
    slug=re.sub(r'[^a-z0-9]+','_',name).strip('_')
    out.append(dict(id=slug,name=name,aliases=aliases,unit=unit,portion_grams=g,
      kcal=k,kcal_low=round(k*(1-sp)),kcal_high=round(k*(1+sp)),
      protein_g=p,protein_low=round(p*(1-sp),1),protein_high=round(p*(1+sp),1),
      oil_sensitive=oil=='1',source=kind,source_note=note))
json.dump(out,open(os.path.join(os.path.dirname(__file__),'..','internal','dishes','dishes.json'),'w'),indent=1,ensure_ascii=False)
print(len(out),"dishes")
