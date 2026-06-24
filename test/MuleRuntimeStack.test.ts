import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Configuration } from '../src/Configuration';
import { MuleRuntimeStack } from '../src/MuleRuntimeStack';

describe('MuleRuntimeStack taskCount logic', () => {
  const defaultProps = {
    env: { account: '123456789012', region: 'eu-central-1' },
    configuration: {
      taskCount: 0,
      branchName: 'main',
      buildEnvironment: { account: '123456789012', region: 'eu-central-1' },
      targetEnvironment: { account: '123456789012', region: 'eu-central-1' },
      domainName: 'test.com',
      hostedZoneId: 'Z123',
      cpu: 1024,
      memoryLimitMiB: 2048,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
    } as unknown as Configuration,
  };

  test('should create exactly 1 ECS Service when taskCount is 0', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackZero', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 0 },
    });

    const template = Template.fromStack(stack);

    // The logic Math.max(1, props.configuration.taskCount) ensures that
    // at least 1 service is created even if taskCount is 0.
    template.resourceCountIs('AWS::ECS::Service', 1);
  });

  test('should create exactly 3 ECS Services when taskCount is 3', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackThree', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 3 },
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::ECS::Service', 3);
  });
});
