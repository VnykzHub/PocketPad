# PocketPad

**Turn any TV browser into a game console, and every phone into a controller. No app, no cables, no account.**

> Status: **pre-alpha, in design.** The spec is written (see [`docs/SPEC.md`](docs/SPEC.md)); the code is not. Nothing below is shipped yet unless marked otherwise. "PocketPad" is a working name.

---

## What it is

Open a page on your TV's browser. It shows a QR code. Scan it with your phone, and your phone becomes a game controller with touch controls, motion sensing, vibration (on Android) and private screens. Up to 8 people can play at once.

The game runs entirely on the TV. Phones only send controller input (about 26 bytes per packet), so phones stay cool and the server stays cheap.

## Why it's different

- **Zero install.** A browser on the TV and a browser on the phone. That's all.
- **The phone is a better controller than a gamepad.** Multi-touch, gyro, a screen, a keyboard, custom layouts per game.
- **Private screens.** Secret words, hidden roles and personal hands of cards, which a single shared TV can't do.
- **Built to be light.** Small bundles and a tight memory budget, so it can run on TV browsers with weak chips.
- **Open.** An MIT-licensed engine and SDK so anyone can build games for it.

## How it works

```
TV browser (host)  <---->  Server  <---->  Phone browser (controller)
 runs the game              pairs rooms,       sends touch, gyro,
 draws the screen           relays messages    buttons; shows private UI
```

1. The TV page asks the server for a room and shows a QR code, a 4-character code and a PIN.
2. A phone scans the QR (or types the code and PIN) and joins as P1 to P8.
3. The phone sends input over a WebSocket. The game on the TV reads it and reacts.
4. The game can send back vibration, layout changes and private content to any phone.

## Planned features

- Join in under 5 seconds from QR scan
- Up to 8 controllers per room, with reconnect after a Wi-Fi drop or phone sleep
- Controller layouts defined as JSON by the game: buttons, sticks, d-pad, triggers, touchpad, sliders, gyro, choice lists, text entry, a drawing canvas and private panels
- Layouts that can change at runtime, per player
- Android vibration, with visual and audio feedback fallbacks on iOS
- Game SDK with a manifest format, a layout validator and a sample game
- Performance gates in CI: bundle size, frame time and input latency

## Planned games

Reaction Duel, Sumo Bumpers, Draw and Guess, Tilt Maze Race, Spy in the Room, Bluff Quiz, Tank Arena, Snake Royale, Steering Wheel Racer, Sword Swing Duel, Bomb Defusal, Beat Tap, Heist Planner, and an open-world engine showcase. Each has a minimal and a full version in the spec.

## Honest limits

- **iOS has no web vibration API.** iPhones get visual and audio feedback instead.
- **Gyro needs HTTPS.** On a plain LAN address it won't work, so development uses a tunnel for sensor tests.
- **TV browsers vary a lot.** Memory and speed differ by brand and year, so budgets are set from measurements on real TVs, not assumptions.
- **TVs add display lag** (often worse outside Game Mode). It's measured separately from the app's own latency.
- **Some networks block device-to-device traffic** (guest Wi-Fi, hotels). The hosted version avoids this.

## Development plan

**Phase 1: Dev.** Everything is proven on a local network: one Node process, no domain and no cloud. It covers the protocol, controller, runtime, pairing, layouts, sensors, and four proof games, plus 17 measured experiments on real TVs and phones.

**Phase 2: Production.** Only after Phase 1 passes its exit review: pages on a static host, a regional relay server, HTTPS, hardening and open-sourcing.

See the full roadmap and budgets in [`docs/SPEC.md`](docs/SPEC.md).

## Quick start (target workflow, not available yet)

```bash
git clone <repo-url> && cd pocketpad
npm install
npm run dev
```

The dev server will print a LAN address and a QR code:

- Open `http://<your-lan-ip>:8080/` on the TV (or any PC browser) to host.
- Scan the QR with a phone to join as a controller.

To test gyro, run a tunnel to the dev server and use its HTTPS URL on the phone.

## Repository layout (planned)

```
packages/protocol/     shared types and binary codecs (zero dependencies)
packages/dev-server/   local server for development
packages/relay/        production server
packages/runtime/      game loop, renderer, input mapper, asset loader
packages/controller/   the phone app
packages/games/        games
experiments/           standalone probe pages for TV and phone measurements
sdk/                   manifest schema, layout validator, sample game
tools/                 latency harness, input bots, size-budget check
```

## Contributing

Not open yet. The best help right now is **testing on real hardware**: once the probe pages exist, running them on your TV and phone and posting results (device, OS, browser version, numbers) is the most valuable contribution. Contribution guidelines will land in Phase 2.

## License

The engine, protocol, controller app and SDK will be released under the MIT License. Games keep their authors' licenses. The project name and the hosted hub are not covered by the MIT license.
