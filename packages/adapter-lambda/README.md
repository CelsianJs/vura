# @celsian/vura-adapter-lambda

AWS Lambda adapter for [Vura](https://vura.io) applications.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-adapter-lambda)](https://www.npmjs.com/package/@celsian/vura-adapter-lambda)

## What it does

`@celsian/vura-adapter-lambda` runs after `vura build` and packages the build output into an AWS Lambda + API Gateway v2 deployment. It generates a Lambda handler entry and a SAM/CloudFormation template so you can deploy with the AWS CLI or `sam deploy`. All Vura route kinds (`serverless`, `task`) map to Lambda functions; hot routes (`kind: 'hot'`) require persistent Node.js processes and cannot run on Lambda.

## Install

```sh
npm install @celsian/vura-adapter-lambda
```

## Minimal example

**vura.config.ts:**

```ts
import { defineConfig } from '@celsian/vura-core';
import { lambdaAdapter } from '@celsian/vura-adapter-lambda';

export default defineConfig({
  adapter: lambdaAdapter({ region: 'us-east-1' }),
});
```

Build and test locally with the AWS SAM CLI:

```sh
vura build
sam local start-api
```

## Documentation

- [Self-host on Lambda — /self-host/lambda/](https://vura.io/self-host/lambda/)
- [Adapters overview — /self-host/](https://vura.io/self-host/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
