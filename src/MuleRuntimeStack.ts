import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Configurable } from './Configuration';
import { Statics } from './Statics';

interface MainStackProps extends StackProps, Configurable { }

export class MainStack extends Stack {
  constructor(scope: Construct, id: string, private readonly props: MainStackProps) {
    super(scope, id, props);

    new s3.Bucket(this, 'bucket', {
      bucketName: `${Statics.projectName}-test`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}