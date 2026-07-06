# Privacy Policy

**Version 0.1.0 — DRAFT** · Effective date: [KIRBY: confirm effective date before publishing — placeholder 2026-07-06]

> **DRAFT — not yet in force.** This is a working draft pending review and legal sign-off. Every item marked **[KIRBY: …]** must be confirmed before this page is published.

This Privacy Policy explains how [KIRBY: confirm the exact legal entity name — must match the [Terms of Service](/terms)] ("**Vura**", "**we**", "**us**") collects, uses, and shares information when you use the Vura platform — the dashboard at `app.vura.io`, the API at `api.vura.io`, application hosting on `*.vura.app`, our command-line tools, and related services (the "**Service**").

This policy covers information about **you as a Vura customer**. It does **not** cover data that *your* deployed applications collect from *their* end users — for that data you are the controller and are responsible for your own privacy notice.

## 1. Information we collect

**Account information.** When you create an account we collect your email address and, optionally, your name. If you sign up with a password, we store a securely hashed version of it (never the plaintext password).

**GitHub OAuth data.** If you sign in with or connect GitHub, we receive and store your GitHub user ID, GitHub username, avatar URL, and an access token that lets us act on your behalf to build and deploy your repositories. We request the following GitHub scopes:

| Scope | What it grants | Why we request it |
|---|---|---|
| `repo` | Full read/write access to your repositories, including private ones | Read your source to build and deploy it, and report deployment status |
| `read:user` | Read your GitHub profile | Populate your account (name, username, avatar) |
| `user:email` | Read your GitHub email addresses | Associate your account with your email |
| `admin:repo_hook` | Create and manage repository webhooks | Trigger new builds automatically when you push |

> [KIRBY: the `repo` and `admin:repo_hook` scopes are broad — full repository read/write plus webhook administration, not read-only. Consider whether to narrow these scopes (e.g. move to a GitHub App with per-repo, least-privilege installation permissions) before general availability. This policy describes the scopes honestly rather than understating them.]

> [KIRBY: security — the GitHub access token is currently stored unencrypted in the database (plain `text` column), while environment variables are encrypted at rest (AES-256-GCM). Encrypt the stored GitHub token before GA. This is an internal remediation note, not text to publish.]

**Team and billing information.** For teams, we store the team name, plan, billing email, and — for paid plans — a Stripe customer ID, subscription ID, price ID, and subscription status. We do **not** store your full card numbers; payments are processed by Stripe (see Subprocessors).

**Deployment data.** When you deploy, we store your build artifacts, static assets, and deployment metadata (commit information, build logs, deployment status). Environment variables you add are encrypted at rest.

**Usage and request logs.** We record request logs and aggregate usage meters to operate the Service and bill metered plans. Metered dimensions include bandwidth, function invocations, build minutes, hot-server running time, background task invocations, and static requests. Logs may include information such as timestamps, request paths, status codes, and IP addresses. [KIRBY: confirm exactly what request-log fields are retained, especially whether end-user IP addresses are logged and for how long.]

**Support and communications.** If you contact us, we keep your messages and contact details to respond.

## 2. Cookies and local storage

The Service **does not set tracking or advertising cookies**, and we do not use third-party analytics or advertising trackers on the dashboard. Authentication uses bearer tokens rather than server-set session cookies:

- **Browser local storage** holds your authentication tokens and interface preferences (such as sidebar and list-view settings).
- **Browser session storage** temporarily holds a GitHub OAuth "state" value during sign-in for security.

These are strictly functional and stay in your browser. [KIRBY: if you later add any analytics (e.g. privacy-friendly, cookieless) or a cookie for any purpose, this section and the cookie disclosure must be updated. Confirm the marketing site vura.io itself carries no third-party trackers.]

## 3. How we use information

We use the information described above to:

- provide, operate, maintain, and secure the Service;
- authenticate you and manage your account and teams;
- build, deploy, host, and route your applications;
- meter usage and bill paid plans through Stripe;
- enforce plan limits, quotas, and our [Terms of Service](/terms), and detect and prevent abuse, fraud, and security incidents;
- communicate with you about your account, security, and service changes; and
- comply with legal obligations.

[KIRBY: confirm whether you will send product/marketing emails and, if so, add the legal basis / opt-out language. This draft assumes transactional and service emails only.]

## 4. How we share information — subprocessors

We do **not sell your personal information**, and we do not share it for advertising. We share information with the infrastructure and service providers ("subprocessors") we use to run the Service, only as needed to provide it:

| Subprocessor | Purpose | Data involved |
|---|---|---|
| **Fly.io** | Runs hot-server and build-worker compute | Build artifacts, application runtime data, logs |
| **Cloudflare** | Edge routing, KV state, R2 object storage, and TLS for custom domains | Request traffic, static assets, artifacts, routing/suspension state |
| **Neon** | Primary Postgres database | Account, team, billing, deployment, and usage records |
| **Upstash** | Redis for rate limiting, queues, and transient state | Rate-limit counters, OAuth state, job data |
| **Stripe** | Subscription billing and payment processing | Billing email, payment details (held by Stripe), usage records |
| **Vercel** | Hosts the Vura dashboard web application | Dashboard delivery (static frontend assets) |
| **GitHub** | Authentication and source repository access | GitHub identity, repository contents, webhooks |

[KIRBY: confirm this subprocessor list is complete and current before publishing, and confirm the hosting regions / countries for each so we can describe international transfers accurately. Consider publishing a versioned subprocessor list with a change-notification commitment for enterprise customers.]

We may also disclose information if required by law, to enforce our Terms, or to protect the rights, safety, and security of Vura, our customers, or the public. If Vura is involved in a merger, acquisition, or sale of assets, information may be transferred as part of that transaction, subject to this policy.

## 5. Data retention

We retain your information for as long as your account is active and as needed to provide the Service, and afterward as required for legal, accounting, security, and dispute-resolution purposes.

- **Account and team records** — kept while your account exists; deleted or anonymized after account deletion, subject to the exceptions below.
- **Request logs / usage records** — retained for [KIRBY: confirm log retention window — e.g. 30 / 90 days for raw request logs; aggregated usage meters retained for billing history].
- **Build artifacts and deployment assets** — retained for [KIRBY: confirm artifact retention — e.g. kept for active deployments; old artifacts pruned after N days or N versions].
- **Audit and billing records** — some records (such as security/audit-log entries and billing history) are intentionally retained after account deletion for legal, financial, and security reasons.

[KIRBY: fill in the exact retention windows above. The platform keeps audit-log entries even after account deletion by design — confirm the maximum retention period.]

## 6. Data security

We take reasonable technical and organizational measures to protect your information, including encryption of environment variables at rest (AES-256-GCM), hashing of passwords, scoped access tokens, and access controls. No system is perfectly secure, and we cannot guarantee absolute security. [KIRBY: confirm whether you want to commit to a breach-notification timeframe and a security contact / disclosure process.]

## 7. Your rights

Depending on where you live, you may have rights to access, correct, export, or delete your personal information, and to object to or restrict certain processing.

- **Access and correction** — you can view and update your account information in the dashboard.
- **Deletion** — you can delete your account yourself from the dashboard. Deletion requires re-authentication and is blocked while you own a team with projects, other members, or an active paid subscription; resolve those first. Deleting your account removes your user record and associated personal data, except records we must retain (Section 5).
- **Other requests** — contact us to exercise any rights not self-served in the product.

We will not discriminate against you for exercising these rights. [KIRBY: confirm which framework(s) you want to name explicitly — GDPR (EU/UK), CCPA/CPRA (California), or a neutral "applicable law" posture. This draft stays neutral; add framework-specific sections if you target those markets.]

## 8. International data transfers

We and our subprocessors may process and store information in countries other than yours. [KIRBY: confirm the actual processing regions for each subprocessor and add the appropriate transfer-mechanism language (e.g. Standard Contractual Clauses) if you serve EU/UK customers.]

## 9. Children

The Service is not directed to children, and you must meet the minimum age stated in our [Terms of Service](/terms) to use it. We do not knowingly collect personal information from children below that age. [KIRBY: confirm minimum age, consistent with the Terms.]

## 10. Changes to this policy

We may update this Privacy Policy from time to time. If we make material changes we will take reasonable steps to notify you, such as by email or a notice in the dashboard. The "Effective date" above reflects the latest version.

## 11. Contact

Questions or privacy requests: **[KIRBY: confirm privacy contact email — e.g. privacy@vura.io]**. [KIRBY: if you target the EU/UK, confirm whether a data-protection representative or DPO must be named here.]
