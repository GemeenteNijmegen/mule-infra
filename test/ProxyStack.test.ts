import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Configuration } from '../src/Configuration';
import { MuleRuntimeStack } from '../src/MuleRuntimeStack';
import { ProxyStack } from '../src/ProxyStack';

describe('ProxyStack', () => {
  const defaultProps = {
    env: { account: '123456789012', region: 'eu-central-1' },
    configuration: {
      branchName: 'development',
      buildEnvironment: { account: '123456789012', region: 'eu-central-1' },
      deploymentEnvironment: { account: '123456789012', region: 'eu-central-1' },
      taskCount: 1,
      cpu: 2048,
      memoryLimitMiB: 16384,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      proxyEnabled: true,
    } as unknown as Configuration,
  };

  test('creates Fargate Task Definition and 4 SSM parameters', () => {
    const app = new App();
    const muleStack = new MuleRuntimeStack(app, 'MuleRuntimeStack', {
      ...defaultProps,
    });

    const proxyStack = new ProxyStack(app, 'ProxyStack', {
      ...defaultProps,
      vpc: muleStack.vpc,
      cluster: muleStack.cluster,
      messageQueueSecurityGroup: muleStack.messageQueueSecurityGroup,
    });

    const template = Template.fromStack(proxyStack);

    template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
    template.resourceCountIs('AWS::SSM::Parameter', 4);
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    // Egress to the ActiveMQ web console port is attached on the proxy side.
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 8162,
      ToPort: 8162,
    });
  });
});
