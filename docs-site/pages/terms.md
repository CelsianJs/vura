# Terms of Service

**Version 0.1.0 — DRAFT** · Effective date: [KIRBY: confirm effective date before publishing — placeholder 2026-07-06]

> **Beta notice.** Vura is a beta product. Features, limits, and these Terms may change while the service is in beta. Do not run production workloads that you cannot afford to lose without your own backups and monitoring in place.

> **DRAFT — not yet in force.** This document is a working draft pending review and legal sign-off. Every item marked **[KIRBY: …]** is a decision or fact that must be confirmed before this page is published.

These Terms of Service ("**Terms**") are a legal agreement between you ("**you**", "**your**", or "**Customer**") and [KIRBY: confirm the exact legal entity name and form — e.g. "Vura, Inc." / "ZVN Dev Ltd." / a sole proprietorship] ("**Vura**", "**we**", "**us**", or "**our**") governing your access to and use of the Vura platform, including the dashboard at `app.vura.io`, the API at `api.vura.io`, application hosting on `*.vura.app`, our command-line tools, and related services (together, the "**Service**").

By creating an account, clicking "I agree", or otherwise accessing or using the Service, you agree to be bound by these Terms and by our [Privacy Policy](/privacy). If you do not agree, do not use the Service.

If you are using the Service on behalf of an organization, you represent that you have authority to bind that organization to these Terms, and "you" refers to that organization.

## 1. The Service

Vura is a deployment platform for web applications built with the Vura/What framework. The Service builds your application from source, hosts static assets and serverless functions, optionally runs always-on "hot" server processes and background tasks, routes traffic through a global edge network, and meters your resource usage.

The Service integrates with GitHub for authentication and to build and deploy your source repositories. Your use of GitHub is also governed by GitHub's own terms.

## 2. Beta status

The Service is provided as a **beta**. This means:

- Features may be added, changed, deprecated, or removed at any time.
- Availability, performance, and resource limits are not guaranteed.
- We may impose, change, or remove usage limits and quotas at any time.
- Data loss, downtime, and breaking changes are more likely than in a generally-available product. You are responsible for maintaining your own backups of any source code, data, or configuration you value.

[KIRBY: confirm whether you want a formal beta SLA disclaimer of "no uptime guarantee during beta", or whether any uptime commitment applies. Current draft: no SLA during beta.]

## 3. Accounts and teams

**Accounts.** To use the Service you must create an account, either with an email address and password or by signing in with GitHub. You must provide accurate information and keep it up to date. You are responsible for all activity under your account and for keeping your credentials and access tokens secure. Notify us promptly of any unauthorized use.

**Eligibility.** You must be at least [KIRBY: confirm minimum age — 13, 16, or 18 depending on target jurisdiction and GDPR posture] years old and legally able to enter into these Terms to use the Service.

**Teams.** The Service lets you create teams and invite members. The team owner is responsible for the team's use of the Service, including its plan, billing, and the conduct of its members. Deleting your personal account is blocked while you still own a team that has projects, other members, or an active paid subscription — you must transfer or wind those down first (see Section 8).

## 4. Plans, billing, and usage

**Plans.** The Service offers a **Free** plan and paid **Starter** and **Pro** plans. Each plan sets included allowances and limits — for example daily request caps, monthly build-minute and bandwidth allowances, serverless compute limits, and whether always-on "hot" routes are available. Current plan details and limits are shown in the dashboard and may change during beta.

[KIRBY: confirm the public prices for Starter and Pro, and the billing period (monthly/annual). Prices are not stated in this draft — the platform reads them from Stripe price configuration, not from source.]

**Metered usage.** Paid plans include usage-based billing. We meter your usage of the Service, which may include:

- requests served (serverless function invocations and static requests),
- bandwidth,
- build minutes,
- hot-server running time, and
- background task invocations.

Metered usage above your plan's included allowance is billed at our then-current rates. [KIRBY: confirm which dimensions are actually billed to the customer vs. tracked-only. In the current platform only **requests, bandwidth, and build minutes** are reported to the billing processor as metered charges; hot-server time and task invocations are measured but confirm their billing treatment before publishing.]

**Payment.** Paid plans are processed by Stripe. By subscribing to a paid plan you authorize us and Stripe to charge your payment method for subscription fees and metered usage. You are responsible for all taxes except taxes on our net income. Fees are [KIRBY: confirm — non-refundable except where required by law?].

**Non-payment.** If a charge fails or an account becomes past due, we may downgrade, suspend, or restrict your access until the balance is paid. See also Section 6 on suspension.

**Changes to pricing.** We may change plans, prices, and metered rates. For paid subscribers we will [KIRBY: confirm notice period for price changes — e.g. 30 days' notice by email] before a change takes effect.

## 5. Acceptable use

You are responsible for everything you build, deploy, and run on the Service, and for all content and code you upload. You must not use the Service to:

- host, distribute, or transmit content that is illegal, or that infringes or misappropriates the intellectual property, privacy, or other rights of others;
- upload, host, or distribute malware, viruses, or other malicious code, or use the Service to attack, probe, or disrupt any system or network;
- perform cryptocurrency mining or other operations whose primary purpose is to consume compute resources rather than serve an application;
- abuse platform resources — for example by attempting to evade metering or quotas, running workloads designed to overload shared infrastructure, or consuming resources in a way that degrades the Service for others;
- send spam or unsolicited bulk communications, or host phishing, fraud, or other deceptive content;
- host [KIRBY: confirm your stance on adult content, gambling, and other lawful-but-restricted categories];
- violate any applicable law or regulation, or the terms of any third-party service you connect (including GitHub and Stripe).

We may investigate suspected violations and may remove or disable content or workloads that we believe violate these Terms or create risk or liability for us or others.

## 6. Quotas, suspension, and enforcement

To protect the Service and other customers, we enforce plan limits and quotas. If your usage exceeds your plan's caps — for example your daily request limit — we may automatically **suspend** your team's traffic until usage falls back within limits, you upgrade your plan, or the applicable period resets. Enforcement is applied at our edge and is asynchronous, so a brief overage may occur before suspension takes effect.

We may also suspend or throttle access, or apply rate limits, in response to abuse, security risks, non-payment, or violations of these Terms. Where practical and appropriate we will aim to notify you, but for security or resource-protection reasons suspension may be immediate.

## 7. Your content and responsibilities

**Your content.** You retain all rights to the source code, applications, data, and other content you deploy or upload ("**Your Content**"). You grant us the limited rights to host, copy, build, transmit, cache, and display Your Content solely as needed to provide and operate the Service, and to enforce these Terms.

**Your responsibility.** You are solely responsible for Your Content, including its legality, the security of your applications, obtaining all necessary rights and consents, and complying with all laws that apply to your users and their data. If your application collects personal data from end users, you are the controller of that data and are responsible for your own privacy notices and legal bases.

**GitHub access.** When you connect GitHub, you authorize us to access your repositories and manage deployment webhooks in order to build and deploy your applications. The permissions we request are described in our [Privacy Policy](/privacy). You may revoke this access at any time through GitHub, though doing so may disable builds and deployments.

## 8. Termination and account deletion

**By you.** You may stop using the Service at any time. You can delete your account yourself from the dashboard (which calls our account-deletion endpoint). For your protection, deletion requires you to re-authenticate, and is blocked while you still own a team that has projects, other members, or an active paid subscription — resolve those first. Deleting your account removes your user record and associated personal data as described in the [Privacy Policy](/privacy); certain records (such as audit and billing records) may be retained as described there and as required by law.

**By us.** We may suspend or terminate your access to the Service, in whole or in part, if you materially breach these Terms, fail to pay, create security or legal risk, or if we discontinue the Service. Except where a breach or legal obligation requires immediate action, we will aim to give you reasonable notice.

**Effect of termination.** On termination, your right to use the Service ends and we may delete Your Content and account data after any applicable retention window. Sections that by their nature should survive (including ownership, disclaimers, limitation of liability, indemnification, and governing law) survive termination.

## 9. Third-party services

The Service relies on and integrates with third-party providers, including GitHub, Stripe, and our infrastructure subprocessors (listed in the [Privacy Policy](/privacy)). We are not responsible for third-party services, and your use of them may be subject to their own terms. Availability of the Service may depend on the availability of these providers.

## 10. Disclaimers

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE", AND IS A BETA PRODUCT. TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, SECURE, ERROR-FREE, OR THAT DATA WILL NOT BE LOST. YOU USE THE SERVICE AT YOUR OWN RISK AND ARE RESPONSIBLE FOR YOUR OWN BACKUPS.

## 11. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, VURA AND ITS OWNERS, EMPLOYEES, AND SUPPLIERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, GOODWILL, OR BUSINESS, ARISING OUT OF OR RELATED TO THE SERVICE OR THESE TERMS, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

OUR TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THE SERVICE OR THESE TERMS WILL NOT EXCEED THE GREATER OF (A) THE AMOUNTS YOU PAID US FOR THE SERVICE IN THE [KIRBY: confirm — 3, 6, or 12] MONTHS BEFORE THE EVENT GIVING RISE TO THE LIABILITY, OR (B) [KIRBY: confirm floor amount — e.g. USD $50, or $0 for free-tier users].

Some jurisdictions do not allow certain limitations, so some of the above may not apply to you.

## 12. Indemnification

You will indemnify and hold harmless Vura and its owners, employees, and suppliers from and against any claims, damages, liabilities, and expenses (including reasonable legal fees) arising out of or related to Your Content, your use of the Service, or your violation of these Terms or applicable law. [KIRBY: confirm whether you want a mutual indemnity or customer-only indemnity for a beta product.]

## 13. Changes to these Terms

We may update these Terms from time to time. If we make material changes we will take reasonable steps to notify you, such as by email or a notice in the dashboard. Changes take effect when posted (or on the stated effective date). Your continued use of the Service after changes take effect means you accept the updated Terms.

## 14. Governing law and disputes

These Terms are governed by the laws of **[STATE/COUNTRY — KIRBY TO CONFIRM]**, without regard to its conflict-of-laws rules. You and Vura agree to the exclusive jurisdiction of the courts located in **[VENUE — KIRBY TO CONFIRM]** for any dispute not subject to [KIRBY: decide whether to include a binding arbitration / class-action-waiver clause — common for US SaaS, but optional and jurisdiction-sensitive].

## 15. General

These Terms, together with the [Privacy Policy](/privacy) and any plan or order terms, are the entire agreement between you and Vura regarding the Service. If any provision is found unenforceable, the rest remains in effect. Our failure to enforce a provision is not a waiver. You may not assign these Terms without our consent; we may assign them in connection with a merger, acquisition, or sale of assets.

## 16. Contact

Questions about these Terms: **[KIRBY: confirm contact email — e.g. legal@vura.io]**.
