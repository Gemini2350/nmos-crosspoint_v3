# Single sign-on (OpenID Connect)

Add an `oidc` block to `users.json` and restart. The login dialog then offers "Sign in with <label>" next to the local login, which keeps working.

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
