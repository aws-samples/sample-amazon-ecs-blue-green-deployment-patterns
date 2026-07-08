FROM public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app.py .

ENTRYPOINT ["python", "app.py"]
