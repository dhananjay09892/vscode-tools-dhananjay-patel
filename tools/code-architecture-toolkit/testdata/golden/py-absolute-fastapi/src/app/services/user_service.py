from app.models.user import User
from app.missing import nope


def get_user() -> User:
    return User(name='test')
