#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Qa3BackendStack, Qa3WafStack } from '../lib/qa3-backend-stack';

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;

/* Web ACL (scope: CLOUDFRONT) i certyfikat ACM dla CloudFront muszą być wdrożone w us-east-1.
 * crossRegionReferences przekazuje je do stacka w regionie API,
 * ale wymaga jawnie ustawionego 'env' w obu stackach. */
const wafStack = new Qa3WafStack(app, 'Qa3WafStack', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
});

/* Region API = region z konfiguracji CLI (tak jak wcześniej przy stacku bez 'env'). */
new Qa3BackendStack(app, 'Qa3BackendStack', {
  env: { account, region: process.env.CDK_DEFAULT_REGION },
  crossRegionReferences: true,
  webAclArn: wafStack.webAclArn,
  certificate: wafStack.certificate,
});
