import * as dockerBuild from '@pulumi/docker-build';
import * as pulumi from "@pulumi/pulumi";
import * as resources from '@pulumi/azure-native/resources';
import * as containerregistry from '@pulumi/azure-native/containerregistry';
import * as containerinstance from '@pulumi/azure-native/containerinstance';
import * as redisModule from '@pulumi/azure-native/redis';

// Import the configuration settings for the current stack.
const config = new pulumi.Config();
const appPath = config.require('appPath');
const prefixName = config.require('prefixName');

// FIX: Ensure imageName is lowercase for Docker compatibility
const imageName = prefixName.toLowerCase(); 
const imageTag = config.require('imageTag');

const containerPort = config.requireNumber('containerPort');
const publicPort = config.requireNumber('publicPort');
const cpu = config.requireNumber('cpu');
const memory = config.requireNumber('memory');

// Create a resource group.
const resourceGroup = new resources.ResourceGroup(`${prefixName}-rg`);

// FIX: Registry names must be alphanumeric and lowercase.
const registry = new containerregistry.Registry(`${prefixName}acr`.toLowerCase(), {
    resourceGroupName: resourceGroup.name,
    adminUserEnabled: true,
    sku: {
        name: containerregistry.SkuName.Basic,
    },
});

// Get the authentication credentials for the container registry.
const registryCredentials = containerregistry
    .listRegistryCredentialsOutput({
        resourceGroupName: resourceGroup.name,
        registryName: registry.name,
    })
    .apply((creds) => {
        return {
            username: creds.username!,
            password: creds.passwords![0].value!,
        };
    });

// Define the container image for the service.
const image = new dockerBuild.Image(`${prefixName}-image`, {
    // FIX: Force the entire tag string to lowercase using .apply()
    tags: [pulumi.interpolate`${registry.loginServer}/${imageName}:${imageTag}`.apply(t => t.toLowerCase())],
    context: { location: appPath },
    dockerfile: { location: `${appPath}/Dockerfile` },
    platforms: ['linux/amd64'], // Simplified to amd64 for ACI standard compatibility
    push: true,
    registries: [
        {
            address: registry.loginServer,
            username: registryCredentials.username,
            password: registryCredentials.password,
        },
    ],
});

// Create a managed Redis service
const redisCache = new redisModule.Redis(`${prefixName}-redis`, {
    name: `${prefixName}-weather-cache`.toLowerCase(),
    location: resourceGroup.location,
    resourceGroupName: resourceGroup.name,
    enableNonSslPort: true,
    redisVersion: 'Latest',
    minimumTlsVersion: '1.2',
    redisConfiguration: {
        maxmemoryPolicy: 'allkeys-lru'
    },
    sku: {
        name: 'Basic',
        family: 'C',
        capacity: 0
    }
});

const redisAccessKey = redisModule
    .listRedisKeysOutput({ 
        name: redisCache.name, 
        resourceGroupName: resourceGroup.name 
    })
    .apply(keys => keys.primaryKey);

const redisConnectionString = pulumi.interpolate`rediss://:${redisAccessKey}@${redisCache.hostName}:${redisCache.sslPort}`;

// Create a container group in ACI
const containerGroup = new containerinstance.ContainerGroup(
    `${prefixName}-container-group`,
    {
        resourceGroupName: resourceGroup.name,
        osType: 'linux',
        restartPolicy: 'always',
        imageRegistryCredentials: [
            {
                server: registry.loginServer,
                username: registryCredentials.username,
                password: registryCredentials.password,
            },
        ],
        containers: [
            {
                name: imageName,
                image: image.ref,
                ports: [
                    {
                        port: containerPort,
                        protocol: 'tcp',
                    },
                ],
                environmentVariables: [
                    {
                        name: 'PORT',
                        value: containerPort.toString(),
                    },
                    {
                        name: 'WEATHER_API_KEY',
                        value: config.requireSecret('weatherApiKey')
                    },
                    {
                        name: 'REDIS_URL',
                        value: redisConnectionString
                    },
                ],
                resources: {
                    requests: {
                        cpu: cpu,
                        memoryInGB: memory,
                    },
                },
            },
        ],
        ipAddress: {
            type: containerinstance.ContainerGroupIpAddressType.Public,
            dnsNameLabel: `${prefixName}-${imageName}`.toLowerCase(),
            ports: [
                {
                    port: publicPort,
                    protocol: 'tcp',
                },
            ],
        },
    },
);

export const hostname = containerGroup.ipAddress.apply((addr) => addr?.fqdn || "");
export const ip = containerGroup.ipAddress.apply((addr) => addr?.ip || "");
export const url = containerGroup.ipAddress.apply(
    (addr) => `http://${addr?.fqdn}:${publicPort}`,
);