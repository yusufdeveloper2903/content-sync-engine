import type { Comment, Post, Todo, User } from '../../src/domain/content.js';

export const users: User[] = [
  {
    id: 1,
    name: 'Leanne Graham',
    username: 'Bret',
    email: 'leanne@example.com',
    phone: '1-770',
    website: 'hildegard.org',
    companyName: 'Romaguera-Crona',
    city: 'Gwenborough',
  },
  {
    id: 2,
    name: 'Ervin Howell',
    username: 'Antonette',
    email: 'ervin@example.com',
    phone: null,
    website: null,
    companyName: null,
    city: null,
  },
];

export const posts: Post[] = [
  {
    id: 1,
    userId: 1,
    title: 'sunt aut facere repellat',
    body: 'quia et suscipit recusandae consequuntur',
  },
  { id: 2, userId: 1, title: 'qui est esse', body: 'est rerum tempore vitae sequi sint nihil' },
  {
    id: 3,
    userId: 1,
    title: 'ea molestias quasi',
    body: 'et iusto sed quo iure voluptatem occaecati',
  },
  {
    id: 4,
    userId: 2,
    title: 'eum et est occaecati',
    body: 'ullam et saepe reiciendis voluptatem adipisci',
  },
];

export const comments: Comment[] = [
  {
    id: 1,
    postId: 1,
    name: 'id labore',
    email: 'Eliseo@gardner.biz',
    body: 'laudantium enim quasi',
  },
  { id: 2, postId: 1, name: 'quo vero', email: 'Jayne@sydney.com', body: 'est natus enim nihil' },
  {
    id: 3,
    postId: 1,
    name: 'odio adipisci',
    email: 'eliseo@gardner.biz',
    body: 'quia molestiae reprehenderit',
  },
  { id: 4, postId: 2, name: 'alias odio', email: 'Lew@alysha.tv', body: 'non et atque' },
  { id: 5, postId: 4, name: 'et omnis', email: 'Hayden@althea.biz', body: 'harum non quasi' },
];

export const todos: Todo[] = [
  { id: 1, userId: 1, title: 'delectus aut autem', completed: false },
  { id: 2, userId: 1, title: 'quis ut nam', completed: true },
  { id: 3, userId: 1, title: 'fugiat veniam minus', completed: true },
  { id: 4, userId: 1, title: 'et porro tempora', completed: true },
  { id: 5, userId: 2, title: 'laboriosam mollitia', completed: false },
];
