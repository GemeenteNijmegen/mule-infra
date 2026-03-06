import { App } from 'aws-cdk-lib';
import { getConfiguration } from './Configuration';
import { PipelineStack } from './PipelineStack';

const app = new App();

const branchToBuild = process.env.BRANCH_NAME ?? 'development';
const configuration = getConfiguration(branchToBuild);

new PipelineStack(app, 'mule-pipeline-'+ branchToBuild, {
  env: configuration.buildEnvironment,
  configuration: configuration,
});

app.synth();