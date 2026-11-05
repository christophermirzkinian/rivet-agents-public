# Rivet Agents

Run your own Claude Code and Codex chats from your phone. Your agents raise cards; you tap an answer on the
phone and it lands in the right chat on your Mac within seconds.

- **Chat:** talk to any of your chats from the phone. A message with no Reply starts a new chat; a Reply
  continues the one it answers. Attach photos, or dictate with the phone's own mic.
- **Cards:** your agents post cards (a question, options, a picture, a video or a document). You answer on the
  phone, and the bridge types the answer into the chat. With `gh` signed in, it can also comment on the matching
  GitHub pull request or issue.
- **Asks:** a list of what you asked for, its stage (building, needs you, done) and when it is due.
- **Push and install:** web push for new cards, and an installable app for Android and iPhone.
- **Sign-in:** one passkey, yours. No passwords, and nobody else gets in.
- **Read aloud** with the phone's own voice, if you want it.
- **Floor:** every chat at its desk, with a peek at its screen, the backlog, the push queue and the plan.
- **Usage and Machines:** what your chats used, what you used in the app, and how the Mac and your apps are doing.
- **Code:** open PRs and how they stand. An optional merge from a card, off by default.
- **Schedules and jobs:** recurring checks and read-only tasks, with cards when one goes red.
- **Team room:** agent-to-agent messages, redacted before they leave the Mac.
- **Monitor:** one chat that watches the others. Its job is in `docs/monitor-job.md`.
- **Home:** tiles and buttons for your own Home Assistant, set up by you.
- **Rivet's mind:** a map of your own notes and memory folders.
- **Readers:** optional background jobs that read CI, logs and chats and raise cards.
- **Claude Code hooks:** claims, context and log nudges, and hard lines, in `.claude/`.

It is three small pieces: a **server** (Node, keeps the cards and chats), the **phone app** (a PWA the server
serves) and the **bridge** on your Mac, which runs your chats in tmux and types your answers into them.

## What you need

- A Mac with [Node 22+](https://nodejs.org) and tmux (`brew install tmux`). On Node 22 the redactor hides some plain sentences as well as secrets; Node 23 or later keeps them.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) signed in (a Claude Pro or Max plan, or an
  Anthropic API key). Codex is optional.
- A free [Tailscale](https://tailscale.com) account, so your phone can reach the Mac over HTTPS (passkeys need
  HTTPS). Or a [Fly.io](https://fly.io) account if you would rather host the server there.
- Optional: the GitHub CLI `gh`, signed in, for comments on pull requests and issues.

## Install (about 10 minutes)

1. **Get the code.** Use the clone URL from the green Code button on this page.

   ```sh
   git clone <repo URL> rivet-agents
   cd rivet-agents
   npm install
   ```

2. **Give the Mac an HTTPS address.** Install Tailscale on the Mac and on your phone, sign in to both with the
   same account, then run:

   ```sh
   tailscale serve --bg 8130
   ```

   It prints an `https://` address for your Mac. Only devices on your own Tailscale account can open it.

3. **Write your settings.** Use the address from step 2:

   ```sh
   npm run setup -- \
     --origin https://<address>
   ```

   This writes `.env` (mode 0600) with fresh random tokens and web-push keys, and prints your one-time sign-in
   link. Add `--keychain` to keep the tokens in the macOS Keychain as well, and
   `--repos you/your-repo,you/other-repo` to let the bridge comment on those GitHub repos.

4. **Start it.**

   ```sh
   npm run install-bridge
   ```

   This builds the app, copies it to `~/.rivet-agents/app` and starts two launchd agents, the server and the bridge. They
   start again on their own after a restart. `npm run install-bridge -- --status` shows how they are doing.

5. **Sign in on the phone.** Open the sign-in link that setup printed, create your passkey, then use
   **Add to Home Screen** (iPhone: Share → Add to Home Screen; Android: the menu → Install app). Allow
   notifications when it asks.

6. **Start a chat.**

   ```sh
   npm run chat -- new myproject --cwd ~/code/myproject
   ```

   It starts Claude Code in tmux in that folder, and the chat shows up under Chat on the phone.
   `npm run chat -- ls` lists your chats; `npm run chat -- open myproject` attaches your terminal to one.

## How an agent posts a card

Any script or agent on the Mac can post a card with the CLI. Tell your agents about it in their `CLAUDE.md`.

```sh
npm run --silent rivet -- card add colours \
  --chat myproject \
  --title "Pick a colour for the header" \
  --ask "The header is grey today. Which colour should it be?" \
  --option "Blue" --recommended --option "Green" --option "Keep it as it is"
```

Your answer is typed into the chat named by `--chat`. `npm run rivet -- --help` lists every command: cards
with pictures and videos (`--media`), your asks, threads and the board.

## Optional features

Everything here is off until you turn it on, and nothing in the repo points at anyone's accounts. Every setting is
listed in [`.env.example`](.env.example).

**Ops page.** Set `RIVET_HEALTH_URLS` (`name=https://example.com/health`, comma-separated) for the apps to check,
`RIVET_FLY_APPS` for Fly apps the bridge should read with `flyctl`, and `RIVET_REPOS` for your GitHub repos.

**Merge from a card.** Set `RIVET_MERGE=on`. A yes on a merge-ready card then runs plain `gh pr merge` for a repo in
`RIVET_REPOS`. It refuses unless every required check is green, and a branch with no required checks is refused too.
It has no admin flag, so your rulesets and branch protection still decide.

**Readers.** Set `RIVET_READERS=on` and run `scripts/install-readers.sh`. Readers run a Claude CLI on a schedule, so
they use your plan or API key. See [`readers/README.md`](readers/README.md).

**Home.** Run your own Home Assistant, or the one in [`home-automation/`](home-automation/README.md). Set
`RIVET_HA_URL`, and put a token in the Keychain under `rivet-agents-home-assistant` or in `RIVET_HA_TOKEN`. The token
stays on the bridge. `~/.rivet-agents/home.json` holds two lists, and nothing is built in:

```json
{
  "tiles": [{ "label": "Example reading", "entity_id": "sensor.example_reading", "unit": "units" }],
  "buttons": [{ "label": "Example lamp", "service": "light.turn_on", "entity_id": "light.example_lamp", "data": {} }]
}
```

`unit` and `data` are optional. At most 24 tiles and 12 buttons; invalid entries are left out, and `data` cannot name
another target. The bridge calls only the services you list. See `home-automation/home.example.json`.

**Rivet's mind.** Set any of `RIVET_MIND_MEMORY_DIR`, `RIVET_MIND_NOTES_DIR` and `RIVET_MIND_DECISIONS_DIR`, then run
`scripts/install-mind.sh`. With none set, the map is empty and shows a setup note.

**Monitor.** Set `RIVET_MONITOR_CHAT` to the folder name of the chat that should run it. The session-start hook hands
it `docs/monitor-job.md` and its state file. Point `RIVET_MONITOR_JOB` at your own copy to change the job.

## Security

- **One passkey.** The server takes one owner. The one-time sign-in link stops working once it has been used.
- **Tokens are stored as SHA-256 hashes** on the server; the plain tokens are kept only in your `.env` (and the
  Keychain if you asked for it).
- **The bridge only makes outbound connections** to your server; nothing listens on your Mac but the server.
- **Your agents run with your permissions**, exactly as they do in your terminal. The bridge types text; it does
  not widen what an agent may do.
- With Tailscale, only your own devices can reach the server.

## Run the server on Fly.io instead

The bridge stays on the Mac; the server moves to Fly (a small machine and a 1 GB volume). Skip step 2 and the
Tailscale part; set `app` in `fly.toml` to your own app name first.

```sh
npm run setup -- --origin https://<your-app>.fly.dev
fly apps create <your-app>
fly volumes create rivet_data --size 1
grep -v "^#" .env | fly secrets import    # the settings setup just wrote
fly deploy
echo "RIVET_URL=https://<your-app>.fly.dev" >> .env
npm run install-bridge -- --no-server      # the bridge only, on the Mac
```

## Uninstall

```sh
npm run install-bridge -- --uninstall      # stops both agents and removes their plists
rm -rf ~/.rivet-agents                     # the app copy, your cards and chats, logs
tailscale serve reset
```

## Develop

```sh
npm run dev:server     # the server on http://127.0.0.1:8130
npm run dev            # the phone app on http://127.0.0.1:5230, /api proxied to the server
npm run typecheck
npm test
```

`web/preview/chat.html` renders the Chat screen with sample data and needs no server.

## Licence

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Every shipped asset is listed in `web/public/LICENSES.yaml`.
