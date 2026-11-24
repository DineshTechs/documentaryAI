"""Runtime configuration, read from environment variables."""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data")).resolve()
PROJECTS_DIR = DATA_DIR / "projects"
DB_PATH = DATA_DIR / "app.db"

# Where the cinematic-skill repo is cloned (the Dockerfile clones it here).
SKILL_REPO = Path(os.environ.get("SKILL_REPO", "/opt/cinematic-skill")).resolve()
SKILL_DIR = SKILL_REPO / "skills" / "cinematic-film"
SKILL_SCRIPTS = SKILL_DIR / "scripts"

APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")
# Public URL of the app, e.g. https://studio.example.com (used for the YouTube OAuth redirect).
BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000").rstrip("/")

PYTHON_BIN = os.environ.get("PYTHON_BIN", "python3")
AGENT_MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "80"))
BASH_DEFAULT_TIMEOUT = int(os.environ.get("BASH_DEFAULT_TIMEOUT", "600"))
BASH_MAX_TIMEOUT = int(os.environ.get("BASH_MAX_TIMEOUT", "3600"))

for d in (DATA_DIR, PROJECTS_DIR):
    d.mkdir(parents=True, exist_ok=True)
