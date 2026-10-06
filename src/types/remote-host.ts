export interface IRemoteHost {
  id: string;
  name: string;
  address: string;
  username: string;
  port: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IRemoteHostsData {
  hosts: IRemoteHost[];
  updatedAt: string;
}

export interface IRemoteHostInput {
  name: string;
  address: string;
  username: string;
  port?: number;
  description?: string;
}
