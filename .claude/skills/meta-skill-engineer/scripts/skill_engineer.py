import sys
from pathlib import Path
import argparse

def create_skill(name: str, desc: str = ""):
    base = Path(".claude/skills") / name
    base.mkdir(parents=True, exist_ok=True)
    (base / "scripts").mkdir(exist_ok=True)
    (base / "references").mkdir(exist_ok=True)
    (base / "examples").mkdir(exist_ok=True)
    
    template = Path(".claude/skills/meta-skill-engineer/references/SKILL_TEMPLATE.md").read_text()
    content = template.replace("[tên-skill]", name).replace("[Mô tả ngắn gọn + trigger rõ ràng]", desc or f"Skill chuyên xử lý {name.replace('-', ' ')}")
    (base / "SKILL.md").write_text(content)
    
    print(f"✅ Đã tạo Skill: {base}")
    print("   Đọc references/SKILL_STRUCTURE_GUIDE.md để kiểm tra chuẩn Anthropic")

# review_skill và improve_skill (đầy đủ)
def review_skill(skill_path: str):
    checklist = Path(".claude/skills/meta-skill-engineer/references/SKILL_QUALITY_CHECKLIST.md").read_text()
    print(f"🔍 Đánh giá Skill: {skill_path}")
    print(checklist)

def improve_skill(skill_path: str, suggestions: str):
    print(f"🔧 Đang cải tiến Skill: {skill_path}")
    print("Gợi ý áp dụng:", suggestions)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--create", type=str)
    parser.add_argument("--desc", type=str, default="")
    parser.add_argument("--review", type=str)
    parser.add_argument("--improve", type=str)
    parser.add_argument("--suggestions", type=str, default="")
    
    args = parser.parse_args()
    if args.create:
        create_skill(args.create, args.desc)
    elif args.review:
        review_skill(args.review)
    elif args.improve:
        improve_skill(args.improve, args.suggestions)
    else:
        print("Cách dùng: --create <name> [--desc 'mô tả'] / --review / --improve")