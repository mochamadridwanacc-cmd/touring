FROM python:3.9-slim

WORKDIR /app

# Copy all application files
COPY . /app

# Expose default cloud port
ENV PORT=8080
EXPOSE 8080

# Run TouringMate server
CMD ["python3", "server.py"]
