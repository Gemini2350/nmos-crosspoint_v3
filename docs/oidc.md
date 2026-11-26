# Single sign-on (OpenID Connect)

Set it up on the Setup page under "Single sign-on (OpenID Connect)": only members of the `admin` group see and change it, and a change applies at once, without a restart. The login dialog then offers "Sign in with <label>" next to the local login, which keeps working. "Test provider" checks that the issuer answers with its configuration and signing keys; the page also shows the redirect URIs to register at the provider.

Saving a change ends all single sign-on sessions, so a right taken away does not live on. Switched off, the settings stay and come back when it is switched on again.

The settings are kept as the `oidc` block of `users.json`, which can also be written by hand (then restart):

```json
"oidc": {
    "issuer": "https://idp.example.com/realms/media",
    "clientId": "nmos-crosspoint",
    "groupsClaim": "realm_access.roles",
    "groupMap": { "crosspoint-operators": ["user"], "crosspoint-admins": ["user", "admin"] },
    "label": "Company SSO"
}
```

Register `https://<crosspoint>/auth/oidc/callback` as redirect URI with the provider, and `https://<crosspoint>/` as post-logout redirect URI. The flow is authorization code with PKCE.

| Field | Default | |
| --- | --- | --- |
| `issuer`, `clientId` | | Both set: single sign-on is on. |
| `clientSecret` | none | For a confidential client; without it the client is public. |
| `redirectUri` | from the request | Set it when a proxy hides the scheme or the host the browser used: the redirect URI the provider is sent, and whether the session cookie is `Secure`, follow from it. |
| `scopes` | `openid profile email` | |
| `groupsClaim` | `groups` | ID token claim with the user's groups or roles; a dotted path reads a nested one, e.g. `realm_access.roles`. |
| `groupMap` | none | Claim value -> crosspoint groups. |
| `defaultGroups` | none | Groups every signed-in user gets. |
| `label` | `SSO` | Text of the sign-in button. |
| `sessionHours` | `12` | |

A signed-in user belongs to the groups `groupMap` and `defaultGroups` give them, and `permissions` is checked against those; its `users` lists only match local accounts. An account that maps to no group is not signed in. Sessions are kept in memory, so a restart signs everyone out.
