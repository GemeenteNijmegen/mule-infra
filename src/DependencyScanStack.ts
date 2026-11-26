import { PermissionsBoundaryAspect } from '@gemeentenijmegen/aws-constructs';
import { Aspects, Stack, StackProps, aws_ec2 as ec2, aws_ecs as ecs, aws_efs as efs, aws_iam as iam } from 'aws-cdk-lib';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Configurable } from './Configuration';
import { Statics } from './Statics';

export interface DependencyScanStackProps extends StackProps, Configurable {
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly fileSystem: efs.IFileSystem;
  /**
   * A runtime's access point holding the apps Runtime Manager deployed. One is
   * enough: Runtime Manager deploys the same apps to every runtime.
   */
  readonly accessPoint: efs.IAccessPoint;
}

/**
 * Stack creating an on-demand Trivy scan of the Mule apps on EFS. The image
 * scan never sees these jars, as they live on the mounted volume.
 *
 * No ECS Service or schedule is created - developers run the scan via:
 *   ./scripts/dependency-scan.sh
 * which starts the task and runs Trivy in it over ECS Exec.
 */
export class DependencyScanStack extends Stack {
  constructor(scope: Construct, id: string, props: DependencyScanStackProps) {
    super(scope, id, props);
    Aspects.of(this).add(new PermissionsBoundaryAspect());

    const securityGroup = new ec2.SecurityGroup(this, 'DependencyScanSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for the on-demand dependency scan task',
      allowAllOutbound: true,
    });
    // Attached from this side so the rule lives here, keeping the dependency
    // direction DependencyScanStack -> MuleRuntimeStack.
    securityGroup.connections.allowToDefaultPort(props.fileSystem, 'EFS for the dependency scan');

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'DependencyScanTaskDefinition', {
      cpu: 1024,
      memoryLimitMiB: 4096,
    });

    const container = taskDefinition.addContainer('TrivyContainer', {
      image: ecs.ContainerImage.fromRegistry(props.configuration.containerImages.trivyImage),
      // Idle until the script runs the scan over ECS Exec; the timeout stops a
      // task the script did not clean up.
      entryPoint: ['sleep'],
      command: ['3600'],
    });

    taskDefinition.addVolume({
      name: 'mule-data',
      efsVolumeConfiguration: {
        fileSystemId: props.fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: props.accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });
    // Read-only: the volume also holds mule-agent.yml.
    container.addMountPoints({
      containerPath: '/scan',
      readOnly: true,
      sourceVolume: 'mule-data',
    });

    taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['elasticfilesystem:ClientMount'],
      resources: [props.fileSystem.fileSystemArn],
      conditions: {
        StringEquals: {
          'elasticfilesystem:AccessPointArn': props.accessPoint.accessPointArn,
        },
      },
    }));

    // Grant SSM execute-command permissions so the script can run the scan.
    taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    const privateSubnets = props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });

    // Publish discovery parameters so dependency-scan.sh needs no hard-coded values.
    new StringParameter(this, 'DependencyScanClusterName', {
      parameterName: Statics.ssmDependencyScanClusterName,
      stringValue: props.cluster.clusterName,
      description: 'ECS cluster name for the on-demand dependency scan task',
    });
    new StringParameter(this, 'DependencyScanTaskDefinitionArn', {
      parameterName: Statics.ssmDependencyScanTaskDefinitionArn,
      stringValue: taskDefinition.taskDefinitionArn,
      description: 'Fargate task definition ARN for the on-demand dependency scan task',
    });
    new StringParameter(this, 'DependencyScanSubnetId', {
      parameterName: Statics.ssmDependencyScanSubnetId,
      stringValue: privateSubnets.subnetIds[0],
      description: 'Subnet ID for launching the dependency scan task',
    });
    new StringParameter(this, 'DependencyScanSecurityGroupId', {
      parameterName: Statics.ssmDependencyScanSecurityGroupId,
      stringValue: securityGroup.securityGroupId,
      description: 'Security group ID for the dependency scan task',
    });
  }
}
