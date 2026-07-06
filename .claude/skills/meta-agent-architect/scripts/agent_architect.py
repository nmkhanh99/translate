import sys
from pathlib import Path
import argparse

def create_team(project_type: str):
    agents_dir = Path(".claude/agents")
    agents_dir.mkdir(parents=True, exist_ok=True)
    agents_file = agents_dir / "agents.md"
    
    template = Path(".claude/skills/meta-agent-architect/references/AGENT_TEMPLATE.md").read_text()
    content = f"# Autonomous Development Team for {project_type}\n\n"
    
    roles = ["Product Manager (@pm)", "Full-Stack Engineer (@engineer)", "QA Engineer (@qa)", "DevOps Master (@devops)"]
    for role in roles:
        content += template.replace("[Role Name]", role.split(" ")[0]).replace("[mô tả senior level]", "senior specialist") + "\n\n"
    
    agents_file.write_text(content)
    print(f"✅ Đã tạo .claude/agents/agents.md cho dự án {project_type}")
    print("   Bây giờ bạn có thể dùng @pm, @engineer, @qa, @devops trong chat!")

def review_team(agents_path: str):
    checklist = Path(".claude/skills/meta-agent-architect/references/TEAM_QUALITY_CHECKLIST.md").read_text()
    print(f"🔍 Đánh giá Team: {agents_path}")
    print(checklist)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--create", action="store_true")
    parser.add_argument("--project-type", type=str, default="General Project")
    parser.add_argument("--review", type=str)
    
    args = parser.parse_args()
    if args.create:
        create_team(args.project_type)
    elif args.review:
        review_team(args.review)
    else:
        print("Cách dùng: --create [--project-type 'FastAPI + React'] / --review")