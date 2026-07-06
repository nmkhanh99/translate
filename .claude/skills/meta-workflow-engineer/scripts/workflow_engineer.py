import sys
from pathlib import Path
import argparse

def create_workflow(name: str, desc: str = ""):
    Path(".claude/workflows").mkdir(parents=True, exist_ok=True)
    file_path = Path(".claude/workflows") / f"{name}.md"
    
    template = Path(".claude/skills/meta-workflow-engineer/references/WORKFLOW_TEMPLATE.md").read_text()
    content = template.replace("[Tên Workflow]", name.replace('-', ' ').title())
    content = content.replace("[Mô tả ngắn gọn workflow này làm gì]", desc or "Workflow tự động chạy pipeline")
    
    file_path.write_text(content)
    print(f"✅ Đã tạo Workflow: /{name}")
    print(f"   File: {file_path}")
    print(f"   Gõ /{name} để chạy ngay!")

def review_workflow(workflow_path: str):
    checklist = Path(".claude/skills/meta-workflow-engineer/references/WORKFLOW_QUALITY_CHECKLIST.md").read_text()
    print(f"🔍 Đánh giá Workflow: {workflow_path}")
    print(checklist)

def improve_workflow(workflow_path: str, suggestions: str):
    print(f"🔧 Đang cải tiến Workflow: {workflow_path}")
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
        create_workflow(args.create, args.desc)
    elif args.review:
        review_workflow(args.review)
    elif args.improve:
        improve_workflow(args.improve, args.suggestions)
    else:
        print("Cách dùng: --create <name> [--desc 'mô tả'] / --review / --improve")