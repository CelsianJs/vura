# Privacy Policy

**Version 1.0.0** · Effective date: July 7, 2026

The Vura platform is owned and operated by **ZVN DEV**, of Lincoln, Rhode Island, USA — the company behind Vura.

This Privacy Policy explains how ZVN DEV ("**Vura**", "**we**", "**us**") collects, uses, and shares information when you use the Vura platform — the dashboard at `app.vura.io`, the API at `api.vura.io`, application hosting on `*.vura.app`, our command-line tools, and related services (the "**Service**").

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

The GitHub access token we store is encrypted at rest (AES-256-GCM). You can revoke Vura's GitHub access at any time from your GitHub settings.

**Team and billing information.** For teams, we store the team name, plan, billing email, and — for paid plans — a Stripe customer ID, subscription ID, price ID, and subscription status. We do **not** store your full card numbers; payments are processed by Stripe (see Subprocessors).

**Deployment data.** When you deploy, we store your build artifacts, static assets, and deployment metadata (commit information, build logs, deployment status). Environment variables you add are encrypted at rest.

**Usage and request logs.** We record request logs and aggregate usage meters to operate the Service and bill metered plans. Metered dimensions include bandwidth, function invocations, build minutes, hot-server running time, background task invocations, and static requests. Logs may include information such as timestamps, request paths, status codes, and IP addresses.

**Support and communications.** If you contact us, we keep your messages and contact details to respond.

## 2. Cookies and local storage

The Service **does not set tracking or advertising cookies**, and we do not use third-party analytics or advertising trackers on the dashboard. Authentication uses bearer tokens rather than server-set session cookies:

- **Browser local storage** holds your authentication tokens and interface preferences (such as sidebar and list-view settings).
- **Browser session storage** temporarily holds a GitHub OAuth "state" value during sign-in for security.

These are strictly functional and stay in your browser. The marketing site at vura.io likewise carries no third-party trackers.

## 3. How we use information

We use the information described above to:

- provide, operate, maintain, and secure the Service;
- authenticate you and manage your account and teams;
- build, deploy, host, and route your applications;
- meter usage and bill paid plans through Stripe;
- enforce plan limits, quotas, and our [Terms of Service](/terms), and detect and prevent abuse, fraud, and security incidents;
- communicate with you about your account, security, and service changes; and
- comply with legal obligations.

We send transactional and service emails only (for example account, security, billing, and deployment notifications). We do not currently send marketing emails; if that changes, we will update this policy and provide an opt-out.

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

Our subprocessors host data primarily in the United States; Cloudflare operates a global edge network, so cached content and request traffic may transit Cloudflare data centers worldwide. We will update this list as our providers change.

We may also disclose information if required by law, to enforce our Terms, or to protect the rights, safety, and security of Vura, our customers, or the public. If Vura is involved in a merger, acquisition, or sale of assets, information may be transferred as part of that transaction, subject to this policy.

## 5. Data retention

We retain your information for as long as your account is active and as needed to provide the Service, and afterward as required for legal, accounting, security, and dispute-resolution purposes.

- **Account and team records** — kept while your account exists; deleted or anonymized after account deletion, subject to the exceptions below.
- **Request logs / usage records** — raw request logs are retained for up to 90 days; aggregated usage meters are retained as part of billing history.
- **Build artifacts and deployment assets** — kept while the associated deployment or project exists; removed when you delete the deployment, project, or account.
- **Audit and billing records** — some records (such as security/audit-log entries and billing history) are intentionally retained after account deletion for legal, financial, and security reasons.

## 6. Data security

We take reasonable technical and organizational measures to protect your information, including encryption of environment variables at rest (AES-256-GCM), hashing of passwords, scoped access tokens, and access controls. No system is perfectly secure, and we cannot guarantee absolute security. If we become aware of a breach affecting your personal information, we will notify you without undue delay, consistent with applicable law. Security reports: **security@vura.io**.

## 7. Your rights

Depending on where you live, you may have rights to access, correct, export, or delete your personal information, and to object to or restrict certain processing.

- **Access and correction** — you can view and update your account information in the dashboard.
- **Deletion** — you can delete your account yourself from the dashboard. Deletion requires re-authentication and is blocked while you own a team with projects, other members, or an active paid subscription; resolve those first. Deleting your account removes your user record and associated personal data, except records we must retain (Section 5).
- **Other requests** — contact us to exercise any rights not self-served in the product.

We will not discriminate against you for exercising these rights. We honor requests as required by applicable law.

## 8. International data transfers

We and our subprocessors process and store information primarily in the United States. If you use the Service from outside the United States, you understand your information will be transferred to and processed in the United States and other countries where our subprocessors operate.

## 9. Children

The Service is not directed to children, and you must meet the minimum age stated in our [Terms of Service](/terms) to use it. We do not knowingly collect personal information from children under 13.

## 10. Changes to this policy

We may update this Privacy Policy from time to time. If we make material changes we will take reasonable steps to notify you, such as by email or a notice in the dashboard. The "Effective date" above reflects the latest version.

## 11. Contact

Questions or privacy requests: **privacy@vura.io**.
