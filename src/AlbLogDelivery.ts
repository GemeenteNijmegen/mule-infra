import { ArnFormat, RemovalPolicy, Stack, aws_logs as logs } from 'aws-cdk-lib';
import { IApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface AlbLogDeliveryProps {
  readonly loadBalancer: IApplicationLoadBalancer;
  readonly logType: 'ALB_ACCESS_LOGS' | 'ALB_CONNECTION_LOGS';
  /** Names the delivery resources and the log group, so must be unique in the account. */
  readonly name: string;
  readonly retention: logs.RetentionDays;
}

/**
 * Delivers one type of ALB log to its own CloudWatch log group.
 */
export class AlbLogDelivery extends Construct {
  constructor(scope: Construct, id: string, props: AlbLogDeliveryProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/vendedlogs/${props.name}`,
      retention: props.retention,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const source = new logs.CfnDeliverySource(this, 'Source', {
      name: props.name,
      resourceArn: props.loadBalancer.loadBalancerArn,
      logType: props.logType,
    });

    const destination = new logs.CfnDeliveryDestination(this, 'Destination', {
      name: props.name,
      outputFormat: 'json',
      // LogGroup.logGroupArn ends in ':*', which is not the log group's own ARN.
      destinationResourceArn: Stack.of(this).formatArn({
        service: 'logs',
        resource: 'log-group',
        resourceName: logGroup.logGroupName,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
    });

    const delivery = new logs.CfnDelivery(this, 'Delivery', {
      deliverySourceName: props.name,
      deliveryDestinationArn: destination.attrArn,
    });
    delivery.node.addDependency(source);
  }
}
