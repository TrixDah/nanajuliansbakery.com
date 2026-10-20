Nana Julian's Bakery: Bread & Battle
====================================

Core loop
---------
Troops > Field (Wheat) > Mill (Flour) > Bakery (Bread) > Upgrades

Station troops at a field to harvest wheat. Carry wheat to a mill to make flour, then carry flour to a bakery to bake bread. Bring bread home to upgrade troop strength, carrying capacity, and treasury. Resource work requires troops to be present.

World and rivals
----------------
- 27 x 27 map, divided into nine navigable 9 x 9 regions.
- Only your homestead is visible at the start; scout to reveal other plots.
- Four AI rival factions explore, gather, process resources, upgrade, and raid.
- Empty plots can be claimed, but buildings cannot be moved onto them.

Pages
-----
- `index.html` — the game.
- `daily-bread.html` — newspaper placeholder.
- `bake-a-message.html` — local message board; posts stay in this browser.

Run locally
-----------
From this folder, run `python -m http.server 8000` and open http://localhost:8000.

Game saves and message-board posts use separate browser `localStorage` keys. AI runs only while the game page is open. This is a local single-player prototype, not a multiplayer service.
