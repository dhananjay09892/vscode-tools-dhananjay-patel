from app.api.router import router as api_router
from app.services.user_service import (
    get_user as fetch_user,
)
from app.services.billing_service import (
    get_invoice as fetch_invoice,
)
from fastapi import FastAPI

app = FastAPI()


def run() -> None:
    fetch_user()
    fetch_invoice()
    app.include_router(api_router)
