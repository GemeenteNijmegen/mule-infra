import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Configuration, getConfiguration } from '../src/Configuration';
import { DependencyScanStack } from '../src/DependencyScanStack';
import { MuleRuntimeStack } from '../src/MuleRuntimeStack';

describe('DependencyScanStack', () => {
  const props = {
    env: { account: '123456789012', region: 'eu-central-1' },
    configuration: {
      branchName: 'development',
      taskCount: 2,
      cpu: 2048,
      memoryLimitMiB: 16384,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      mqHostInstanceType: 'mq.t3.micro',
      containerImages: getConfiguration('development').containerImages,
    } as unknown as Configuration,
  };

  test('scans the first runtime EFS access point read-only, on demand only', () => {
    const app = new App();
    const muleStack = new MuleRuntimeStack(app, 'MuleRuntimeStack', props);
    const scanStack = new DependencyScanStack(app, 'DependencyScanStack', {
      ...props,
      vpc: muleStack.vpc,
      cluster: muleStack.cluster,
      fileSystem: muleStack.fileSystem,
      accessPoint: muleStack.firstRuntimeAccessPoint,
    });

    const template = Template.fromStack(scanStack);

    const mountPoints = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0]
      .Properties.ContainerDefinitions[0].MountPoints;
    expect(mountPoints).toEqual([expect.objectContaining({ ContainerPath: '/scan', ReadOnly: true })]);
    template.resourceCountIs('AWS::ECS::Service', 0);
    template.resourceCountIs('AWS::Logs::LogGroup', 0);
  });
});
