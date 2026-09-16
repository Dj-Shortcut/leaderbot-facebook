# Testen als gewone Messenger-klant

Status: gedeployd en onafhankelijk teruggelezen op **2026-09-16** via
[deployment 35073398659/1](https://github.com/Dj-Shortcut/leaderbot-facebook/actions/runs/35073398659).
De echte eigenaarstest blijft open. Deze bediening voegt geen Meta-permissie toe.

De eigenaar kan in het eigen Messenger-gesprek met de Page sturen:

- `/testklant aan`: de gewone quota, gekochte credits en providerbudgetten gelden.
- `/testklant status` (of `/testklant`): toon de huidige stand.
- `/testklant uit`: herstel de bestaande beheerdersvrijstellingen voor volgende
  generaties.

De afzender moet in `MESSENGER_ADMIN_IDS` staan. Beheerdersrechten, waaronder
`/stats`, blijven behouden. De schakelaar onderdrukt zowel de vrijstelling via
`MESSENGER_ADMIN_IDS` als via `MESSENGER_QUOTA_BYPASS_IDS`. Gewone gebruikers kunnen
hem niet bedienen en krijgen hierdoor geen extra rechten of tegoeden.

## Voorwaarden en betekenis

- Gebruik de directe Messenger-Page en doorloop de gewone toestemming.
- Inschakelen vereist `MOLLIE_MODE=test`, met legacy en live billing uit. Laat de
  vier gepensioneerde Test user/Page-pins leeg; deze schakelaar is geen testerpin.
- Wacht tot lopende generaties klaar zijn. Een wijziging geldt voor toelatingen
  die de nieuwe opgeslagen stand lezen. Werk dat al toegelaten was, behoudt zijn
  oorspronkelijke quota-/creditboekhouding bij afronding en retries.
- De instelling staat in de bestaande gedeelde Redis-gespreksstatus en wordt
  afgeschermd door workspace, Page, channel connection, binding- en privacy-epoch
  en gebruiker. De app en workers lezen dezelfde status. Wissen, opnieuw koppelen
  of verlopen van die status reset de instelling. De gewone bewaartermijn is
  48 uur zonder statusvernieuwing; actieve face-memory kan die termijn verlengen.
  Controleer daarom `/testklant status` vóór iedere testronde.
- Bij onleesbare status wordt uitvoering niet als eigenaar vrijgesteld. Staat
  klanttesten aan en verandert de betaalconfiguratie weg van veilige Test Mode,
  dan blokkeert nieuwe uitvoering vóór quota-/betaaltoelating. Schakel expliciet
  uit of herstel de Test-configuratie; er is geen automatische livebetaling.

## Echte testronde

1. Zet klanttesten aan en controleer de bevestiging/status.
2. Genereer beelden tot de bestaande gratis dag- of maandquota op zijn. Reeds
   gekochte credits worden daarna normaal gebruikt. De schakelaar reset of
   verhoogt geen limiet en past geen wallet, betaling of intent aan.
3. Als ook het premiumtegoed leeg is, vraag een nieuw beeld. De normale CTA biedt
   één aankoop van **8 premiumcredits voor EUR 4.99**, zonder abonnement, klant,
   subscription of mandate bij Mollie.
4. Open de nieuwe betaalknop, bevestig op de checkoutpagina en kies een betaalde
   Mollie-testbetaling. De browserreturn op zichzelf kent geen credits toe.
5. Controleer server-side de bevestigde webhook, precies één acht-creditgrant en
   daarna één geleverde premiumgeneratie met de gewone debit-/retrygrenzen.
6. Schakel terug met `/testklant uit` wanneer de testronde klaar is.

Geautomatiseerde regressies bewijzen de schakelaar en de bestaande opslaggrenzen.
Een geslaagde deployment is nog geen bewijs van een echte betaling of aflevering.
Blijf af en toe een tweede gebruiker testen voor de scheiding tussen accounts.

## Rollback

Schakel eerst expliciet uit. De instelling wijzigt geen schema en geen financiële
rijen. Een rollback naar een oudere runtime begrijpt deze instelling niet en
herneemt de oude eigenaarsvrijstellingen; die runtime is daarom ongeschikt om
een klanttestronde voort te zetten. Gebruik de beschermde immutable deployment
en het vastgelegde rollback-artifact zoals bij iedere image-gen-release.

## Geverifieerde release 2026-09-16

- Runtimebron: `199a04e3def04a54b0f3cf6c0397da1184fa9694` (PR #563).
- [Trusted build 35071095029](https://github.com/Dj-Shortcut/leaderbot-facebook/actions/runs/35071095029)
  is geslaagd na alle vereiste main-CI-controles. PR-CI bevestigde 2.825 app-tests,
  de aparte Redis/MySQL-suites, typecheck, build en schema-repetitie.
- Image: `registry.fly.io/leaderbot-fb-image-gen@sha256:532e974166413faf86917800bbd83831d031ee23c71542bb24d411c5f9e9ea93`.
- [Provenance 47850881](https://github.com/Dj-Shortcut/leaderbot-facebook/attestations/47850881)
  is ondertekend onder de huidige repositorynaam `Dj-Shortcut/leaderbot-facebook`.
- De onafhankelijke settled-readback bevestigde de voorganger
  `deploy-35065616049-1` met image `e0b82c21ceca12130a892afd01b90cf83fcb3b7a42a2721a9c424a76f1d6f1cf`.
  Het manifest behoudt die exacte herstelconfiguratie plus de checkout-off
  noodconfiguratie. De historische ondertekening blijft op de oude repositorynaam.
- `MOLLIE_MODE=test`, legacy/live uit, lege gepensioneerde testerpins, het
  oorspronkelijke auditverzoek en schema `0018_credit_checkout_reservation`
  blijven de releasegrenzen. Het manifest voert geen operatoractivatie uit.

- [Release-PR #564](https://github.com/Dj-Shortcut/leaderbot-facebook/pull/564)
  is gemerged als `67c100665938355bb9c7610865e67d150861664c`; alle vereiste
  PR- en exacte main-CI-controles zijn geslaagd. Lokaal slaagden 1.909
  productiecontracttests.
- De beschermde deployment slaagde op 2026-09-16 om 08:28 UTC. De onafhankelijke
  settled-readback bevestigde `deploy-35073398659-1`: twee app- en twee
  worker-Machines draaien het hierboven vastgelegde image.
- De read-only operatoraudit bevestigde om 08:29 UTC workspace 1, Test Mode,
  commerciële autorisatie en alle vier scheduler-lanes ingeschakeld op epoch 2.
  Het oorspronkelijke verzoek `8a62f93d-e092-4dd8-82ca-9e77bdd89d54` en operatorrun
  `34581138362/2` bleven behouden. Er was geen herstelmutatie nodig.
- Op alle vier Machines zijn `MOLLIE_MODE=test`, legacy/live billing uit en de
  vier gepensioneerde testerpins leeg. `/healthz` en `/readyz` slagen;
  `/credits/checkout/return` antwoordt met HTTP 200. De tijdelijke auditbundle
  is verwijderd en die verwijdering is teruggelezen.

Dit bewijst de deployment en de betalingsrandvoorwaarden. Er is hiermee geen
Messenger-commando namens de eigenaar verstuurd en geen echte Test-betaling,
creditgrant of premiumaflevering aangetoond. Voer daarvoor de testronde hierboven uit.
