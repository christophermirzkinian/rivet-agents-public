# Home automation

Optional. The Home page in Rivet Agents shows readings from your own Home Assistant and gives you a few buttons for it.
Nothing here runs, and nothing leaves your Mac, until you set it up.

## How it fits together

- **Home Assistant** runs on your Mac, or anywhere the bridge can reach it. The bridge talks to its REST API.
- **`~/.rivet-agents/home.json`** lists the tiles and buttons you want. Nothing is built in: no entity, tile or button
  exists until you put it there.
- **The bridge** sends the server a short list of readings and button labels. Your Home Assistant token stays on the
  bridge and never reaches the server or the phone.
- **A button press** sends only the button's id. The bridge looks it up in `home.json` and calls that service for that
  entity. An id not in the file is refused, so the phone can never ask for anything you did not list.

## Set it up

Already running Home Assistant? Skip to step 3.

1. Install it on this Mac: `home-automation/scripts/install.sh`. It needs [uv](https://docs.astral.sh/uv/), never asks
   for a password, and listens on localhost only. It lives in `~/.rivet-agents/home-assistant`; set `HA_HOME` to change
   that. Your `configuration.yaml` there is yours: running the script again does not replace it.
2. Open `http://127.0.0.1:8123`, make your account and link your devices.
3. In Home Assistant, open your profile, then Security, and create a long-lived access token.
4. Give the bridge the address and the token. Set `RIVET_HA_URL` in your `.env`, for example `http://127.0.0.1:8123`.
   Then either set `RIVET_HA_TOKEN` there too, or keep the token in your Keychain:

   ```sh
   security add-generic-password -U -s rivet-agents-home-assistant -a home-assistant -w
   ```

5. Copy `home-automation/home.example.json` to `~/.rivet-agents/home.json` and put in your own entities.
6. Restart the bridge: `scripts/install-bridge.sh`.

## home.json

```json
{
  "tiles": [{ "label": "Example reading", "entity_id": "sensor.example_reading", "unit": "units" }],
  "buttons": [{ "label": "Lamp on", "service": "light.turn_on", "entity_id": "light.example_lamp", "data": { "brightness_pct": 40 } }]
}
```

- A **tile** is a `label`, an `entity_id` and, if you want one, a `unit`. It shows the entity's state.
- A **button** is a `label`, a `service`, an `entity_id` and, if the service needs it, `data`.
- `data` cannot name a different target: `entity_id`, `device_id`, `area_id`, `floor_id` and `label_id` are refused.
- The most it takes is 24 tiles and 12 buttons. An entry that is not valid is left out, and the bridge log says so.
- The bridge reads the file again on every button press and every reading, so an edit needs no restart.

## What the page says

- **Not set up:** no `RIVET_HA_URL`, or nothing has come from the bridge yet. The page shows how to set it up.
- **Can't reach Home Assistant:** the address or the token is wrong, or Home Assistant is down.
- **Bridge offline:** the Mac is asleep or the bridge has stopped. A button press is refused until it is back.

## Remove it

```sh
launchctl bootout "gui/$(id -u)/dev.rivet-agents.home-assistant"
rm ~/Library/LaunchAgents/dev.rivet-agents.home-assistant.plist
rm -rf ~/.rivet-agents/home-assistant
```
