import sys
from pathlib import Path
import argparse

def create_rule(name: str, desc: str = "", activation: str = "Always On"):
    Path(".claude/rules").mkdir(parents=True, exist_ok=True)
    file_path = Path(".claude/rules") / f"{name}.md"
    
    template = Path(".claude/skills/meta-rule-engineer/references/RULE_TEMPLATE.md").read_text()
    content = template.replace("[Tên Rule Đẹp]", name.replace('-', ' ').title())
    content = content.replace("- Always On", f"- {activation}")
    content = content.replace("## Rules\n- Ràng buộc rõ ràng và cụ thể.", f"## Rules\n- {desc or 'Ràng buộc theo yêu cầu'}")
    
    file_path.write_text(content)
    print(f"✅ Đã tạo Rule ({activation}) tại: {file_path}")

def review_rule(rule_path: str):
    checklist = Path(".claude/skills/meta-rule-engineer/references/RULE_QUALITY_CHECKLIST.md").read_text()
    print(f"🔍 Đánh giá Rule: {rule_path}")
    print(checklist)

def improve_rule(rule_path: str, suggestions: str):
    print(f"🔧 Đang cải tiến Rule: {rule_path}")
    print("Gợi ý áp dụng:", suggestions)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--create", type=str)
    parser.add_argument("--desc", type=str, default="")
    parser.add_argument("--activation", type=str, default="Always On", choices=["Always On", "Manual", "Model Decision", "Glob"])
    parser.add_argument("--review", type=str)
    parser.add_argument("--improve", type=str)
    parser.add_argument("--suggestions", type=str, default="")
    
    args = parser.parse_args()
    if args.create:
        create_rule(args.create, args.desc, args.activation)
    elif args.review:
        review_rule(args.review)
    elif args.improve:
        improve_rule(args.improve, args.suggestions)
    else:
        print("Cách dùng: --create <name> [--desc 'mô tả'] [--activation 'Always On'] / --review / --improve")