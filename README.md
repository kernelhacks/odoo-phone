# Phone Webphone

This module embeds a SIP/WebRTC softphone directly inside Odoo. Every internal user can receive a dedicated SIP extension that is registered through the browser using `sip.js`.

## Features

- Manage SIP/WebRTC credentials per user inside Odoo.
- Enforce one-to-one mapping between users and SIP extensions.
- Provide a backend client action that loads a softphone UI in the Odoo web client.
- Floating softphone accessible from every backend screen via the systray phone icon.
- Click-to-call button next to every phone field when viewing CRM, Contacts, etc.
- Support WebSocket, STUN and TURN configuration for WebRTC connectivity.
- Bundles `sip.js` locally so no external CDN is required.

## Setup

1. Install the module in your Odoo instance.
2. As a member of **Phone Manager**, create a SIP Account for each user under *Phone -> Configuration -> SIP Accounts*.
3. Make sure the WebSocket endpoint exposed by your PBX or SBC is reachable from the users' browsers.
4. Optionally define STUN/TURN services to suit your network topology.
5. Users can open *Phone -> Webphone* or click the floating phone icon to display the softphone panel.
6. Any phone field now exposes a *Webphone* button that instructs the softphone to dial that number.

## Notes

- Credentials are stored in plaintext to allow the web client to authenticate. Keep access restricted to trusted administrators and consider deploying at-rest encryption if required.
- The default STUN server (`stun.l.google.com:19302`) is used when no ICE servers are defined.
- Calls are handled through the embedded SIP.js stack, so browser permissions for microphone access must be granted.
