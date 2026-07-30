import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from './user.entity';

export type PublicUser = Omit<User, 'passwordHash'>;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async create(data: {
    email: string;
    passwordHash: string;
    fullName: string;
    companyName?: string;
  }): Promise<User> {
    const user = this.usersRepository.create({
      email: data.email,
      passwordHash: data.passwordHash,
      fullName: data.fullName,
      companyName: data.companyName,
    });

    return this.usersRepository.save(user);
  }

  toPublicUser(user: User): PublicUser {
    const { passwordHash: _passwordHash, ...publicUser } = user;

    return publicUser;
  }
}
