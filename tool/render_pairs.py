import fitz, os
SRC="/Users/khanhnm/Desktop/translate/2024 CFA L1 Curriculum/2024 L1V1-Prerequisite Quant.pdf"
VI="/Users/khanhnm/Desktop/translate/2024 CFA L1 Curriculum - VI (agent pilot)/2024 L1V1-Prerequisite Quant.pdf"
OUT="agent_pilot/review"
src=fitz.open(SRC); vi=fitz.open(VI)
dpi=130; m=fitz.Matrix(dpi/72,dpi/72)
gap=20
for i in range(src.page_count):
    p1=src[i].get_pixmap(matrix=m); p2=vi[i].get_pixmap(matrix=m)
    W=p1.width+gap+p2.width; H=max(p1.height,p2.height)
    doc=fitz.open(); pg=doc.new_page(width=W, height=H)
    pg.insert_image(fitz.Rect(0,0,p1.width,p1.height), pixmap=p1)
    pg.insert_image(fitz.Rect(p1.width+gap,0,p1.width+gap+p2.width,p2.height), pixmap=p2)
    pg.get_pixmap(matrix=fitz.Matrix(1,1)).save(f"{OUT}/pair_{i:03d}.png")
    if i%40==0: print("rendered", i, flush=True)
print("DONE all", src.page_count)
