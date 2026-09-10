import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
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
      mqHostInstanceType: 'mq.m5.large',
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

  test('shares one application log group across every task', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackAppLogs', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 3 },
    });

    const template = Template.fromStack(stack);

    // Three tasks, three runtime log groups, but only one application group -
    // that is what keeps a correlation ID readable in a single place.
    const logGroups = Object.values(template.findResources('AWS::Logs::LogGroup'))
      .map(group => group.Properties.LogGroupName);
    expect(logGroups.filter(name => name === '/mule/main/apps')).toHaveLength(1);

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/mule/main/apps',
      RetentionInDays: 180,
    });

    // Every task definition points its apps at that one group and stream. The
    // group name is a Ref, so comparing the refs is what proves the three tasks
    // share a group rather than each getting their own.
    const [appLogGroupId] = Object.entries(template.findResources('AWS::Logs::LogGroup'))
      .find(([, group]) => group.Properties.LogGroupName === '/mule/main/apps')!;
    const taskDefinitions = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    expect(taskDefinitions).toHaveLength(3);
    taskDefinitions.forEach(taskDefinition => {
      const environment = taskDefinition.Properties.ContainerDefinitions[0].Environment;
      expect(environment).toEqual(expect.arrayContaining([
        { Name: 'MULE_APP_LOG_GROUP', Value: { Ref: appLogGroupId } },
        { Name: 'MULE_APP_LOG_STREAM', Value: 'apps' },
      ]));
    });
  });

  test('lets the task role write to the application log group', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackAppLogsIam', { ...defaultProps });

    const template = Template.fromStack(stack);

    // The appender runs in the application JVM, so this must be on the task
    // role - the execution role only covers the awslogs driver.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
          }),
        ]),
      },
    });
  });

  test('runs the broker as a single instance in exactly one subnet', () => {
    const app = new App();
    const stack = new MuleRuntimeStack(app, 'MuleRuntimeStackBroker', {
      ...defaultProps,
      configuration: { ...defaultProps.configuration, taskCount: 1 },
    });

    const template = Template.fromStack(stack);

    const broker = Object.values(template.findResources('AWS::AmazonMQ::Broker'))[0];
    expect(broker.Properties.DeploymentMode).toBe('SINGLE_INSTANCE');
    expect(broker.Properties.HostInstanceType).toBe('mq.m5.large');
    expect(broker.Properties.SubnetIds).toHaveLength(1);
    // The name carries a hash of the replacement-forcing properties, so a
    // replacing update never collides with the broker it replaces.
    expect(broker.Properties.BrokerName).toMatch(/^MuleMessageQueue-[0-9a-f]{8}$/);
  });
});
