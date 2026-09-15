import { App } from 'aws-cdk-lib';
import { getConfiguration } from '../src/Configuration';
import { MainStage } from '../src/MainStage';

describe('MainStage', () => {
  const grafanaStackId = (branchName: string) => {
    const app = new App();
    const stage = new MainStage(app, 'stage', {
      env: getConfiguration(branchName).deploymentEnvironment,
      configuration: getConfiguration(branchName),
    });
    return stage.node.children.find(child => child.node.id === 'grafana-stack');
  };

  test('deploys the Grafana stack on development', () => {
    expect(grafanaStackId('development')).toBeDefined();
  });

  test.each(['acceptance', 'main'])('does not deploy the Grafana stack on %s', (branchName) => {
    expect(grafanaStackId(branchName)).toBeUndefined();
  });
});
