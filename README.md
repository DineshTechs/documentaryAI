# Documentary Studio

A web app for a YouTube documentary channel, built around
[cinematic-skill](https://github.com/Moh4696/cinematic-skill). cinematic-skill makes narrated cinematic films from
code, using archive photos, maps, clippings, stamps and red string, with Skia and ffmpeg doing the drawing.

cinematic-skill is normally driven by Claude Code or Codex. This app has its own built-in AI agent that reads the skill's
`SKILL.md` and runs its scripts on your server, so you can make films from the browser with any AI provider.

## Features

- **Film pipeline**: Story → Voice → Images → Scene → Review → Render, all run by the agent with live progress.
  The agent stops for your approval at the skill's checkpoints (beat table, look, 30-second draft). You can approve
  or request changes, and you can message the agent at any time.
- **Any AI provider**: Anthropic Claude, OpenAI, Google Gemini, OpenRouter, DeepSeek, Groq, Mistral, xAI, or any
  OpenAI-compatible server (Ollama, LM Studio, vLLM). Set a default, override it per film, and switch mid-film.
- **Narration voice**: OpenAI TTS, ElevenLabs or espeak-ng. You can also upload your own voice recording.
- **Research**: Wikipedia search and page reading built in. Add a Brave Search key for full web search.
- **Files**: browse every script, beat table, image, still and render. Edit text files in the browser and upload your
  own photos or music.
- **Preview**: watch drafts and the final film, see review stills, and download the MP4 and SRT.
- **YouTube metadata**: AI-written titles (5 options), description with chapters and the image credits the licences
  require, tags, and thumbnail ideas. Grab a thumbnail frame from the video or upload your own.
- **Auto-upload to YouTube**: resumable upload, with captions (SRT) and the thumbnail attached automatically. Publish
  as private, unlisted or public, or schedule a release time.
- **Ideas & calendar**: a kanban board (Ideas → Research → Production → Scheduled → Published), AI brainstorming, a
  monthly release calendar, and "Make film" on any idea.
- **Telegram bot**: control everything from your phone and get push notifications (see below).
- Password login and automatic HTTPS (Caddy). Runs natively on Ubuntu or WSL with one install script; Docker is optional.

## Deploy on a cloud server (no Docker)

**Server:** Ubuntu **24.04** (or 22.04) VPS with at least **4 vCPU and 8 GB RAM** (16 GB recommended), and full root
access. Choose plain Ubuntu, with no cPanel or Plesk image, because those panels take the web ports the app's HTTPS
needs. Rendering is CPU-heavy: a 90-second 1080p film takes about 6 minutes on a 16 GB machine. MilesWeb, Hetzner,
DigitalOcean and Contabo all work.

1. **Point a domain** (e.g. `studio.yourchannel.in`) at the server's IP with a DNS **A record**.
2. **Get the code onto the server** (log in with SSH first: `ssh root@SERVER_IP`):
   ```bash
   git clone https://github.com/DineshTechs/documentaryAI.git /opt/documentary-studio
   cd /opt/documentary-studio
   ```
   (For a private repo, GitHub asks for your username and a personal access token as the password.)
3. **Install:**
   ```bash
   sudo bash install.sh --domain studio.yourchannel.in
   ```
   It installs Python, ffmpeg, espeak-ng, fonts, cinematic-skill and the Python packages. It asks you to choose the
   web-app password, creates a `studio` user to run the app (never root), and sets the app up as a service that
   starts on boot. It also installs **Caddy** for free automatic HTTPS and opens ports 80/443.
4. Open `https://studio.yourchannel.in`, log in, and go to **Settings**.

**Everyday commands on the server:**

| What | Command |
|---|---|
| Update the app + cinematic-skill (after you `git_push.bat`) | `sudo bash /opt/documentary-studio/studio.sh update main` (or `deploy.bat main` on your PC) |
| Live logs | `journalctl -u documentary-studio -f` |
| Restart / stop / start | `sudo systemctl restart documentary-studio` (or `stop` / `start`) |
| Change the web password | edit `/opt/documentary-studio/.env`, then restart |

**Where things live:** code in `/opt/documentary-studio`; films, database, Python packages and cinematic-skill in
`/home/studio/.documentary-studio/`. Back up `/home/studio/.documentary-studio/data`.

<details><summary>Alternative: run with Docker instead</summary>

```bash
curl -fsSL https://get.docker.com | sh
cp .env.example .env && nano .env      # set DOMAIN, APP_PASSWORD, SECRET_KEY (openssl rand -hex 32)
docker compose up -d --build
```
Update cinematic-skill with `docker compose build --no-cache studio && docker compose up -d`. Data lives in the
`studio-data` Docker volume. Don't run the Docker setup and the native install on the same server at once.
</details>

### First-time setup in the app (Settings page)

1. **Channel**: name, style and audience notes, and the description footer.
2. **AI models**: paste an API key for at least one provider, set the model, and click **Test connection**. Then pick
   the default provider and model. The agent needs a model with tool/function calling. Strong models produce much
   better films.
3. **Narration voice**: choose OpenAI TTS or ElevenLabs for the final voice, then click **Test voice**.
4. **Render server**: click **Run setup check** to confirm Python packages, ffmpeg and fonts.
5. **YouTube** (for auto-upload):
   - In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**.
   - Set up the **OAuth consent screen** (External), and add your Google account as a **test user**.
   - Create **Credentials → OAuth client ID → Web application**, with the redirect URI shown in Settings.
     The app detects it automatically from where it's running. If you use the app both locally and on the
     server, add both to the same client:
     `https://your-domain/oauth/youtube/callback` and `http://localhost:8000/oauth/youtube/callback`.
   - Paste the client ID and secret into Settings, save, and click **Connect YouTube channel**.
   - Note: while the Google app is in "Testing" mode, refresh tokens expire after 7 days, so you'll need to reconnect.
     Publishing the consent screen avoids that. Custom thumbnails need a phone-verified YouTube channel.

## Telegram bot

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token it gives you.
2. In the web app, go to **Settings → Telegram bot**, paste the token, tick **Enable bot**, set your timezone, and save.
3. Tap **Open pairing link** (or send `/start CODE` to your bot). Only paired accounts can use the bot, and each
   code works once. You can pair more accounts (e.g. an editor) and remove them in Settings.

The bot uses long polling from your server, so it needs no webhook or extra port.

**Notifications** (sent to every paired account):
- ✋ approval requests with the summary, the beat table and stills attached, plus Approve / Request changes buttons
- 💬 the agent waiting for an answer: just reply
- ▸ stage changes, ⚠️ errors (with a Retry button), and 🎬 finished films with the video attached (up to 50 MB)
- ✅ YouTube upload finished, or ⚠️ upload failed
- Set Notifications to "Everything" to also get every agent message.

**Commands** (most act on the *active* film, which you set with `/use 3`, or put the film number first: `/video 3`):

| Area | Commands |
|---|---|
| Films | `/films` · `/film 3` · `/use 3` · `/new Title \| topic \| 90 \| 16:9` · `/status` |
| Agent | `/approve [note]` · `/changes what to change` · `/resume` · `/stop` · `/log [n]` · any plain message goes to the agent |
| Files | `/files [filter]` · `/get film/beats.md` · `/video` · `/stills` · send photos, audio, voice notes or documents (≤ 20 MB) to add them to the film's `uploads/` |
| YouTube | `/meta` (`/meta new` regenerates) · `/title …` · `/tags a, b` · `/privacy public` · `/schedule 2026-12-01 18:00` · `/thumb 4.5` · send a photo with the caption `thumbnail` · `/upload` |
| Planning | `/ideas` · `/idea Title \| notes` · `/brainstorm theme` · `/makefilm 5` · `/plan 5 2026-12-10` · `/calendar` |
| AI | `/models` · `/model` · `/model openrouter some/model` · `/model default anthropic claude-sonnet-5-5` |

Telegram limits: bots can send files up to 50 MB and receive files up to 20 MB. Bigger files go through the web app.

## Run on your Windows PC (no Docker)

The app runs inside **WSL** (Windows Subsystem for Linux), the free Ubuntu built into Windows 10/11, using the same
`install.sh` as the server.

1. Double-click **`run_app.bat`**.
   - If WSL isn't installed, it offers to install it. After that, restart the PC, open **Ubuntu** from the Start menu
     once to create a Linux username and password, then double-click `run_app.bat` again.
   - The first run installs everything inside Ubuntu (5–15 minutes). It asks for your Linux password, then a password
     for the web app.
2. Your browser opens **http://localhost:8000**. Keep the window open while you work: closing it stops the app.

| File | What it does |
|---|---|
| `run_app.bat` | Install (first time) and start the app via WSL |
| `stop_app.bat` | Stop the app (WSL or Docker) |
| `update_app.bat` | Update cinematic-skill and Python packages |
| `git_push.bat` | Commit and push your current branch to GitHub |
| `switch_branch.bat` | Switch between develop / main / a feature branch |
| `deploy.bat [name]` | Update a copy on the server (e.g. `deploy.bat staging`) |
| `release.bat` | Merge develop into main and put it live |
| `run_app_docker.bat` | Optional: run with Docker Desktop instead of WSL |

Films and settings are stored inside Ubuntu at `~/.documentary-studio/` (fast Linux disk), separate from the
server's. On Mac or plain Linux, run `./install.sh` once, then `./run.sh`.

## Development and multiple deployments

Run several copies of the app on one server, e.g. **staging** for testing and **main** for your live channel. Each
copy has its own folder, domain, password, port, films, settings, service and code branch, so testing never touches
the live copy.

```
 Your PC (WSL)              GitHub                      MilesWeb server
 ───────────────            ─────────────────           ─────────────────────────────────────────
 edit + test locally  ──►   develop branch  ──deploy──► staging   https://staging.yourchannel.in
 run_app.bat                     │ release.bat
                                 ▼
                            main branch     ──deploy──► main      https://studio.yourchannel.in
```

### One-time setup

1. **Server, live copy:** install `main` as described in [Deploy on a cloud server](#deploy-on-a-cloud-server-no-docker).
2. **PC:** double-click `switch_branch.bat`, choose **develop**, then `git_push.bat`. This creates the `develop`
   branch on GitHub.
3. **DNS:** add an A record for `staging.yourchannel.in` pointing to the same server IP.
4. **Server, staging copy:**
   ```bash
   sudo bash /opt/documentary-studio/studio.sh new staging --domain staging.yourchannel.in --branch develop
   ```
   It asks for a separate password for the staging site and picks a free port automatically (8001, 8002, …).
5. **PC:** the first time you run `deploy.bat`, it asks for your server login (e.g. `root@123.45.67.89`) and saves it
   in `deploy.config`, which isn't pushed to GitHub.

### Everyday flow

| Step | On your PC |
|---|---|
| 1. Work on **develop** and test locally | `run_app.bat` (http://localhost:8000) |
| 2. Save to GitHub | `git_push.bat` |
| 3. Try it on the staging site | `deploy.bat staging` |
| 4. Happy? Put it live | `release.bat` (merges develop → main, pushes, offers to deploy main) |
| Hotfix or feature branch | `switch_branch.bat` → option 3 |

`deploy.bat` warns you if you have changes that aren't pushed yet. When the target is `main`, it asks you to confirm.

### Server commands (`studio.sh`)

| Command | What it does |
|---|---|
| `sudo bash studio.sh list` | All copies: status, port, branch, URL, folder |
| `sudo bash studio.sh new NAME --domain D --branch B [--port P]` | Add a copy (e.g. `test`, `client2`, `channel2`) |
| `sudo bash studio.sh update NAME` / `update all` | Pull its branch from GitHub, update packages, restart |
| `sudo bash studio.sh logs NAME` | Live logs |
| `sudo bash studio.sh restart\|stop\|start NAME` | Control the service |
| `sudo bash studio.sh remove NAME [--purge]` | Remove a copy (`--purge` also deletes its files and films) |

Run these from `/opt/documentary-studio`. Every copy has its own `studio.sh` too.

### Good to know

- **Telegram:** each copy needs its **own bot** (make one per copy with @BotFather). Two copies can't share a token.
- **YouTube:** add each copy's callback (`https://staging.…/oauth/youtube/callback`, `https://studio.…/oauth/…`) to
  the same Google OAuth client. To avoid test uploads on your real channel, connect staging to a second channel, or
  only upload as **private** from staging.
- **AI keys and costs:** each copy has its own Settings, so you can give staging a cheaper model.
- **CPU:** copies share the server, so two films rendering at once each take about twice as long. Stop staging when
  you're not using it: `sudo bash studio.sh stop staging`.
- **Private GitHub repo:** the server asks for your GitHub token on the first update of each copy, then remembers it.
- Never edit code directly on the server. Changes there block updates (`update` will say so).

## How the agent works

```
Browser UI ──► Flask API ──► Agent thread (per film)
                               │  system prompt = app rules + cinematic-skill SKILL.md
                               │  tools: bash, read/write/edit file, list files, view_image,
                               │         web_search, web_fetch, tts_generate,
                               │         set_stage, request_approval, finish
                               ▼
                   /data/projects/<film>/  (film/ = cinematic-skill project, uploads/ = your files)
```

- Each film has its own workspace. Commands run inside it, with `$SKILL_SCRIPTS` and `$FILM` set.
- `request_approval` pauses the agent until you click Approve or Request changes.
- The agent has a step limit per run (`AGENT_MAX_STEPS`, default 80). When it reaches the limit, click **Resume**.
- To keep API costs down, older tool outputs are shortened and only the latest two reviewed images are sent to the
  model.

## Security notes

- The agent can run shell commands on the machine, so keep `APP_PASSWORD` strong. On the server it runs as the
  unprivileged `studio` user (or a non-root user in Docker), never as root.
- API keys are stored in the SQLite database on your server, and the UI only shows their last 4 characters.

## Project layout

```
app/
  main.py      Flask routes (projects, files, approvals, metadata, ideas, settings, OAuth)
  agent.py     film-making agent: tools, loop, approvals, live command output
  llm.py       multi-provider LLM client (Anthropic + OpenAI-compatible) with tool calling and images
  tts.py       OpenAI TTS / ElevenLabs / espeak-ng
  youtube.py   OAuth, resumable upload, captions, thumbnails, AI metadata
  telegram_bot.py  Telegram commands, buttons, file transfer and push notifications
  services.py  actions shared by the web API and the bot
  db.py        SQLite storage
static/        single-page UI (no build step)
install.sh, run.sh, update.sh       native install / start / update (Ubuntu server, WSL, Mac/Linux)
studio.sh                           manage several copies on one server (new, list, update, logs, remove)
*.bat                               Windows helpers (WSL, Docker, git push)
Dockerfile, docker-compose.yml, Caddyfile, .env.example   optional Docker setup
```

cinematic-skill is MIT-licensed © exploraX. Images fetched through it come from Wikimedia Commons, so keep the
credits it generates in your video descriptions. The metadata generator does this automatically.
