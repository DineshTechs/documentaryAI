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
- Password login, HTTPS through Caddy, and everything stored in one Docker volume.

## Deploy on a cloud server

**Server:** Ubuntu 22.04/24.04 VPS with at least **4 vCPU and 8 GB RAM** (16 GB recommended). Rendering is
CPU-heavy: a 90-second 1080p film takes about 6 minutes on a 16 GB machine. Hetzner, DigitalOcean, Contabo and
AWS Lightsail all work.

1. **Point a domain** (e.g. `studio.yourchannel.com`) at the server's IP with a DNS **A record**.
2. **Install Docker** on the server:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
3. **Copy this folder to the server**, for example with `scp -r documentaryVideoProject user@SERVER_IP:~/`, or push it
   to a private GitHub repo and `git clone` it on the server.
4. **Configure:**
   ```bash
   cd documentaryVideoProject
   cp .env.example .env
   nano .env          # set DOMAIN, BASE_URL, APP_PASSWORD, SECRET_KEY (openssl rand -hex 32)
   ```
5. **Start it:**
   ```bash
   docker compose up -d --build
   ```
   Open `https://your-domain`, log in, and go to **Settings**.

**Update cinematic-skill later:** `docker compose build --no-cache studio && docker compose up -d`.

**Backups:** all data (database and film workspaces) lives in the `studio-data` Docker volume.

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
   - Create **Credentials → OAuth client ID → Web application**, with the redirect URI shown in Settings
     (`https://your-domain/oauth/youtube/callback`).
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

## Run locally (Windows / Mac) for testing

With Docker Desktop installed:
```bash
docker build -t documentary-studio .
docker run -p 8000:8000 -e APP_PASSWORD=test -e SECRET_KEY=dev -v studio-data:/data documentary-studio
```
Then open http://localhost:8000. For local YouTube login, add `http://localhost:8000/oauth/youtube/callback` as a
redirect URI too.

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

- The agent can run shell commands inside the container, so keep `APP_PASSWORD` strong. The container runs as a
  non-root user and only sees its own volume.
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
Dockerfile, docker-compose.yml, Caddyfile, .env.example
```

cinematic-skill is MIT-licensed © exploraX. Images fetched through it come from Wikimedia Commons, so keep the
credits it generates in your video descriptions. The metadata generator does this automatically.
