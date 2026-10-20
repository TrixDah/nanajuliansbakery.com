Nana Julian's Bakery: Bread & Battle
====================================

Core loop
---------
Troops -> Field (Wheat) -> Mill (Flour) -> Bakery (Bread) -> Upgrades.
Move troops to harvest wheat, carry it to a mill for flour, bring flour to a
bakery for bread, then return bread to the homestead to improve the brigade,
carrying capacity, or treasury. Work requires troops to be stationed on site.

Game
----
Open index.html for the single-player strategy prototype. It uses a local
browser save and includes nine regions and four rival baker factions.

Bake A Message
--------------
The separate bake-a-message.html page now contains passwordless email-code
login, Village Square group chat, DMs, named groups, and client-side encrypted
messages. This requires the Node.js API server, SQLite and SMTP configuration;
GitHub Pages alone cannot run it. Follow CHAT_SETUP.md before deployment.

Do not commit .env or the .data directory. No server has been configured or
started by this package, and nothing has been deployed by this package.
